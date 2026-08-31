# Enterprise Security Constitution

1. Secret Management:
   - API keys must never be hardcoded or written into public client-side scripts.
   - Credentials must be retrieved at runtime via environment variables or Secret Manager.

2. User Authentication & Authorization:
   - Every API endpoint handling user data must enforce token verification (Firebase Auth).
   - Reject unauthenticated or anonymous access attempts to data pipelines.

3. Database Tenant Isolation:
   - Store all records strictly under `/users/{uid}/...` collections.
   - Enforce database isolation rules so users cannot query or mutate records belonging to other UIDs.

4. Fault Tolerance & Resilience:
   - Implement dynamic retries with backoff for API rate limits (`429`) and high demand (`503`).
   - Use fallback models (`gemini-3.6-flash`, `gemini-3.7-flash`) to ensure continuous service availability.
