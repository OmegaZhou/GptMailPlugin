# Email authentication validation — 2026-10-12

Deployed the independent issuer's email-login mode to the VPS. SMTP credentials
were copied from its existing sender configuration into private issuer config.
The administrator-provisioned Gmail address is the login username. No passwords,
addresses, tokens or production hostnames are included in this report.

Verified:

- Email reached the authorized Gmail inbox from the VPS sender.
- A repeated request within the first 15-minute window left both challenge state
  and password hash unchanged; only one email was delivered in that window.
- Browser login succeeded. Stored challenge became consumed and password hash changed.
- Reusing that password in another browser failed; issuer audit recorded failure.
- After the next window, a second email password authenticated successfully.
- ChatGPT OAuth reconnected after allowing its requested email scope and preserving
  the same owner's canonical subject across the username change.
- The ChatGPT app panel loaded with the email account, authorized status and verified
  connection; no server API key was requested.
- File permissions: challenge and users files 0600, private config files 0640.

Automated checks passed: independent challenge policy tests including concurrent
consumption with Go race detector; existing Authelia handler tests; frontend build
and lint/type checks; four administrator-tool tests; GptMail TypeScript check and
external-token verification test. An isolated startup check now precedes deployment.

The initial build omitted embedded API assets; deployment rolled back successfully.
The build script now includes those resources. Changing the account's subject caused
an OAuth id_token_hint mismatch; renaming now preserves the canonical identity.

Only login test emails were sent. No mailbox was added to GptMail and no business
email was sent or deleted. A different authentication library has not been deployed
or tested; its required token contract is documented in auth/README.md.
