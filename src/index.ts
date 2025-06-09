// src/index.js

// --- CORS Configuration ---
// This allows your frontend at https://donate.frank-ruan.com to make requests to this worker.
const corsHeaders = {
	'Access-Control-Allow-Headers': 'Content-Type',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Origin': 'https://donate.frank-ruan.com',
  };
  
  // --- Main Handler ---
  // It now includes logic to handle CORS preflight requests and add headers to responses.
  export default {
	async fetch(request, env, ctx) {
	  // Handle CORS preflight requests (the browser sends this automatically)
	  if (request.method === 'OPTIONS') {
		return new Response(null, { headers: corsHeaders });
	  }
  
	  // Handle the actual request
	  let response;
	  const url = new URL(request.url);
  
	  if (url.pathname === '/create-checkout-session' && request.method === 'POST') {
		response = await createCheckoutSession(request, env);
	  } else if (url.pathname === '/stripe-webhook' && request.method === 'POST') {
		// Webhooks from Stripe are server-to-server and don't need CORS headers
		return handleStripeWebhook(request, env);
	  } else {
		response = new Response('Not Found.', { status: 404 });
	  }
  
	  // Add CORS headers to the response going back to the browser
	  const responseHeaders = new Headers(response.headers);
	  Object.entries(corsHeaders).forEach(([key, value]) => {
		responseHeaders.set(key, value);
	  });
  
	  return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: responseHeaders,
	  });
	}
  };
  
  
  // --- Application Logic (Unchanged from before) ---
  
  async function createCheckoutSession(request, env) {
	try {
	  const { amount, currency, note, successUrl, cancelUrl } = await request.json();
	  if (!amount || !currency || !successUrl || !cancelUrl) {
		return new Response(JSON.stringify({ error: 'Missing required fields.' }), {
		  status: 400, headers: { 'Content-Type': 'application/json' },
		});
	  }
  
	  const unitAmount = parseInt(amount) * 100;
	  const body = new URLSearchParams({
		'payment_method_types[0]': 'card',
		'line_items[0][price_data][currency]': currency.toLowerCase(),
		'line_items[0][price_data][product_data][name]': 'Donation',
		'line_items[0][price_data][unit_amount]': unitAmount,
		'line_items[0][quantity]': 1,
		'mode': 'payment',
		'success_url': successUrl,
		'cancel_url': cancelUrl,
	  });
  
	  if (note) {
		body.append('payment_intent_data[metadata][donor_note]', note);
	  }
  
	  const stripeResponse = await fetch('https://api.stripe.com/v1/checkout/sessions', {
		method: 'POST',
		headers: {
		  'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
		  'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: body.toString(),
	  });
	  const sessionData = await stripeResponse.json();
	  if (sessionData.error) {
		console.error('Stripe API Error:', sessionData.error.message);
		return new Response(JSON.stringify({ error: sessionData.error.message }), {
		  status: stripeResponse.status, headers: { 'Content-Type': 'application/json' },
		});
	  }
	  return new Response(JSON.stringify({ id: sessionData.id }), {
		status: 200, headers: { 'Content-Type': 'application/json' },
	  });
	} catch (error) {
	  console.error('Error in createCheckoutSession:', error);
	  return new Response(JSON.stringify({ error: 'Internal server error.' }), {
		status: 500, headers: { 'Content-Type': 'application/json' },
	  });
	}
  }
  
  async function handleStripeWebhook(request, env) {
	const signature = request.headers.get('stripe-signature');
	const rawBody = await request.text();
	try {
	  const cryptoKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
	  const [timestampPart, signedPayloadPart] = signature.split(',');
	  const timestamp = timestampPart.split('=')[1];
	  const signedPayload = signedPayloadPart.split('=')[1];
	  const payloadToVerify = `${timestamp}.${rawBody}`;
	  const verified = await crypto.subtle.verify('HMAC', cryptoKey, hexToBuffer(signedPayload), new TextEncoder().encode(payloadToVerify));
  
	  if (!verified) {
		console.error('Webhook signature verification failed.');
		return new Response('Webhook signature verification failed.', { status: 400 });
	  }
  
	  const event = JSON.parse(rawBody);
	  if (event.type === 'checkout.session.completed') {
		const session = event.data.object;
		
		const processedKey = `processed_session_${session.id}`;
		const alreadyProcessed = await env.DONATION_TRACKER_KV.get(processedKey);
		if (alreadyProcessed) {
		  console.log(`Session ${session.id} already processed. Skipping.`);
		  return new Response(JSON.stringify({ status: 'already_processed' }), { status: 200 });
		}
  
		if (session.payment_status === 'paid') {
		  console.log(`Processing paid session: ${session.id}`);
		  await handleSuccessfulPayment(session, env);
		  await env.DONATION_TRACKER_KV.put(processedKey, 'processed', { expirationTtl: 60 * 60 * 24 * 30 });
		}
	  }
	  return new Response(JSON.stringify({ received: true }), { status: 200 });
	} catch (error) {
	  console.error('Error in handleStripeWebhook:', error.stack);
	  return new Response(`Webhook error: ${error.message}`, { status: 400 });
	}
  }
  
  async function retrievePaymentIntent(paymentIntentId, env) {
	  if (!paymentIntentId) return null;
	  const stripeResponse = await fetch(`https://api.stripe.com/v1/payment_intents/${paymentIntentId}`, {
		  headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` }
	  });
	  if (!stripeResponse.ok) {
		  console.error(`Failed to retrieve Payment Intent ${paymentIntentId}`);
		  return null;
	  }
	  return stripeResponse.json();
  }
  
  async function handleSuccessfulPayment(session, env) {
	const amount = (session.amount_total / 100).toFixed(2);
	const currency = session.currency.toUpperCase();
	const donorEmail = session.customer_details?.email;
	const transactionDate = new Date(session.created * 1000).toLocaleString('en-US', { timeZone: 'UTC' });
  
	const paymentIntent = await retrievePaymentIntent(session.payment_intent, env);
	const donorNote = paymentIntent?.metadata?.donor_note || '';
  
	console.log(`Processing successful payment for Telegram: PI ${paymentIntent?.id}`);
  
	let telegramMessage = `🎉 *New Donation Received!* 🎉
  -----------------------------------
  *Amount:* ${amount} ${currency}
  *Donor Email:* ${donorEmail || 'Not provided'}
  *Time (UTC):* ${transactionDate}
  *Payment ID:* ${paymentIntent?.id || session.id}`;
  
	if (donorNote) {
	  telegramMessage += `\n*Note from Donor:* ${donorNote}`;
	}
	telegramMessage += `\n-----------------------------------`;
  
	if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
	  try {
		await sendTelegramNotification(telegramMessage, env);
		console.log('Telegram notification sent successfully.');
	  } catch (err) {
		console.error('Failed to send Telegram notification:', err.message);
	  }
	} else {
	  console.warn('Telegram secrets not configured. Skipping notification.');
	}
  }
  
  async function sendTelegramNotification(message, env) {
	const telegramApiUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
	const payload = {
	  chat_id: env.TELEGRAM_CHAT_ID,
	  text: message,
	  parse_mode: 'Markdown',
	};
	const response = await fetch(telegramApiUrl, {
	  method: 'POST',
	  headers: { 'Content-Type': 'application/json' },
	  body: JSON.stringify(payload),
	});
	if (!response.ok) {
	  const errorBody = await response.json().catch(() => response.text());
	  console.error(`Telegram API Error (${response.status}):`, errorBody);
	  throw new Error(`Failed to send Telegram message`);
	}
	return response.json();
  }
  
  function hexToBuffer(hexString) {
	const bytes = new Uint8Array(hexString.length / 2);
	for (let i = 0; i < hexString.length; i += 2) {
	  bytes[i / 2] = parseInt(hexString.substring(i, i + 2), 16);
	}
	return bytes.buffer;
  }
  