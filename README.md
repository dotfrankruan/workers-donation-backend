# Workers Donation Backend

This project is a Cloudflare Worker that provides a backend for handling donations. It integrates with Stripe for payment processing and sends notifications to a Telegram chat upon successful donations.

## Features

*   **Stripe Integration**: Creates Stripe Checkout sessions for donations.
*   **Webhook Handling**: Securely handles Stripe webhooks to process payment events.
*   **Telegram Notifications**: Sends a notification to a specified Telegram chat when a donation is successfully processed.
*   **Idempotency**: Uses Cloudflare KV to prevent duplicate processing of webhook events.

## Endpoints

*   `POST /create-checkout-session`: Creates a new Stripe Checkout session.
*   `POST /stripe-webhook`: Receives and processes webhooks from Stripe.

## Setup

1.  **Clone the repository.**
2.  **Install dependencies:**
    ```bash
    npm install
    ```
3.  **Configure environment variables:**
    This project requires the following environment variables (secrets) to be configured in your Cloudflare Worker settings:
    *   `STRIPE_SECRET_KEY`: Your Stripe secret key.
    *   `STRIPE_WEBHOOK_SECRET`: Your Stripe webhook signing secret.
    *   `TELEGRAM_BOT_TOKEN`: Your Telegram bot token.
    *   `TELEGRAM_CHAT_ID`: The ID of the Telegram chat to send notifications to.
4.  **Configure KV Namespace:**
    You need to create a KV namespace and bind it to the `DONATION_TRACKER_KV` variable in your `wrangler.jsonc` or via the Cloudflare dashboard.

## Development

To run the worker locally for development, use the following command:

```bash
npm run dev
```

## Deployment

To deploy the worker to Cloudflare, use the following command:

```bash
npm run deploy
