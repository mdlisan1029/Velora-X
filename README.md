# Velora X

Velora X is a Vercel-ready AI workspace for manually selecting AI providers/models, keeping server-side API keys, routing through OpenAI-compatible gateways, and generating media through compatible providers.

## What is included
- Manual provider + model selection (no forced Auto mode)
- Optional provider-order fallback inside the backend
- Streaming chat
- Copy / save text responses
- Media Studio with image/video request routing
- Download generated media URLs when returned by the provider
- Provider Builder UI that generates `PROVIDERS_JSON`
- Built-in provider registry + unlimited custom OpenAI-compatible providers
- Fully inline CSS in `index.html`, so the UI still renders in Quick Edit / standalone HTML previews

## Deploy to Vercel
1. Upload this folder to GitHub.
2. Import the GitHub repo into Vercel.
3. Add environment variables from `.env.example`.
4. Redeploy.

## Adding another AI API later
Use the **Add Providers** tab. Enter the provider name, API key, base URL and default model. Copy the generated JSON into the Vercel environment variable `PROVIDERS_JSON`.

Multiple providers and multiple models per provider can be stored in the same JSON array. Example:

```json
[
  {"id":"my-ai","name":"My AI","key":"sk-...","baseUrl":"https://example.com/v1","model":"my-model"},
  {"id":"another-ai","name":"Another AI","key":"sk-...","baseUrl":"https://another.example/v1","model":"another-model","models":["another-model","another-fast-model"]}
]
```

For media-capable custom providers, add `imageUrl` and/or `videoUrl` to the object. Video APIs are not standardized, so their request/response shape may require a small adapter in `api/media.js`.

## Security
Keep provider API keys in Vercel Environment Variables. Do not put secret keys into the frontend, public GitHub repo, or localStorage.

## Notes
- Free-tier availability, quotas and model IDs change. Configure the model IDs that are currently valid for your accounts.
- The router does not attempt to bypass provider restrictions or quotas.
- A streaming response cannot always be restarted seamlessly on another provider after partial output has already reached the browser.
