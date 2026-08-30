# Security policy

## Reporting

Report security-sensitive findings privately to the byteowlz maintainers. Do not include credentials, host paths, work-directory contents, or working exploits against deployed systems in public issue text.

## Trust model

The SDK transports capabilities; it does not grant them. Oqto's trusted host and runner-side Gate must re-check every server-affecting operation against the App Instance, binding, acting identity, and execution principal.

The web handshake requires:

- a real distinct app origin, never an opaque `null` origin;
- exact parent/app origin comparison, never wildcard matching;
- one nonce-bound transferred `MessagePort`;
- host-only Oqto authentication cookies (prefer the `__Host-` prefix);
- bridge teardown when the iframe unmounts or navigates.

An enabled App is trusted only within its explicitly granted capability and binding scope. The default app CSP should deny network access and unrequested browser permissions.
