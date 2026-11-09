# TrendSpark AI — بوابة سورية

Bilingual, mobile-first AI workspace. Current features: responsive landing page, real Gemini serverless endpoint, local text statistics, cryptographically random password generator, and a basic PWA shell.

## AI setup
Deploy on Vercel or another Node serverless host. Configure `GEMINI_API_KEY` as a server-side environment secret. Optional `GEMINI_MODEL` overrides the default `gemini-2.5-flash`. Never commit API keys or expose them in browser code. A static-only GitHub Pages host cannot run `api/ai.js`.

The assistant returns a clear not-configured error until the secret is set; it does not pretend to be an AI model. Provider quotas and pricing depend on the Google account and model.

## Current scope and honest limitations
No real user accounts, subscriptions, payment processing, VIP entitlement, market feeds, booking, messaging alerts, or 59 live specialist services are implemented. Do not advertise or charge for those capabilities until built, secured and tested. The in-memory deployment is stateless; production needs durable rate limiting, abuse monitoring, privacy notice, terms, and proper operational controls.

## QA
Test both languages, mobile/desktop layouts, text counters/copy/clear, password generation, PWA manifest/icon, API method validation, missing-key behavior, and a real AI response after configuring the secret.