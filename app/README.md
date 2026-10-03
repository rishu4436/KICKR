# KICKR app

Phase 1 has no polished frontend and no wallet UX.

The sign-in contract is server-side: request a nonce, sign the returned message with a Solana keypair, and exchange the signature for a bearer session. A later UI can call `POST /v1/auth/nonce` and `POST /v1/auth/login`. Do not add a product UI in this phase.
