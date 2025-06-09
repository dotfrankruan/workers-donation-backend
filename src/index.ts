// src/index.js

// Expected Environment Variables (Secrets):
// - STRIPE_SECRET_KEY
// - STRIPE_WEBHOOK_SECRET
// - TELEGRAM_BOT_TOKEN
// - TELEGRAM_CHAT_ID
// - KV Namespace Binding: DONATION_TRACKER_KV

export default {
	async fetch(request, env, ctx) {
	  const url = new URL(request.url);
	  if (url.pathname === '/create-checkout-session' && request.method === 'POST') {
		return createCheckoutSession(request, env);
	  } else if (url.pathname === '/stripe-webhook' && request.method === 'POST') {
		return handleStripeWebhook(request, env);
	  }
	  return new Response('Not Found.', { status: 404 });
	},
  };
  
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
  
	  // Add note to metadata IF it exists.
	  // This attaches it to the Payment Intent, which is visible on the dashboard.
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
	  // Webhook signature verification
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
		
		// Idempotency check using KV
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
  
  // Helper to retrieve the full Payment Intent object to access metadata
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
  
	// Retrieve the full Payment Intent to get the note from metadata
	const paymentIntent = await retrievePaymentIntent(session.payment_intent, env);
	const donorNote = paymentIntent?.metadata?.donor_note || '';
  
	console.log(`Processing successful payment for Telegram: PI ${paymentIntent?.id}`);
  
	// Construct Telegram message
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
  
  
	// Send Telegram Notification
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
	  parse_mode: 'Markdown', // Using Markdown for bolding
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
  