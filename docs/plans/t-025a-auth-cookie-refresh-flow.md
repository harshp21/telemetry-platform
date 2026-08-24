# T-025A Plan: Auth Cookie Refresh + CSRF Session Flow

## 1. Business objective and user impact
- Improve browser session security by moving refresh-token handling from JSON payloads to HttpOnly cookies.
- Preserve existing API and microservice Bearer-access-token behavior while hardening web session management.

## 2. Scope and non-goals

### In scope
- Set refresh token as HttpOnly cookie on login.
- Read refresh token from cookie on refresh endpoint.
- Clear refresh token cookie on logout.
- Keep access token issuance and verification as Bearer.
- Add CSRF protection for cookie-authenticated mutation endpoints involved in session lifecycle.
- Update auth-service smoke coverage for cookie-based behavior.

### Non-goals
- Replacing Bearer access-token verification with cookie-only auth.
- Broad frontend UX redesign or unrelated auth UI work.
- Cross-service authorization policy changes.
- Full integration-test expansion (reserved for separate testing slice).

## 3. Acceptance criteria
- Login response sets refresh token using secure cookie attributes.
- Refresh endpoint accepts cookie-based refresh token and rotates token/cookie on success.
- Logout clears refresh cookie and preserves denylist + refresh revocation behavior.
- Missing/invalid cookie refresh token returns `401` with existing invalid-refresh semantics.
- CSRF protections are enforced on cookie-based session mutation routes.
- Existing Bearer access-token flows remain compatible.
- Auth-service scoped validation passes:
  - `pnpm --filter @telemetry/auth-service test`
  - `pnpm --filter @telemetry/auth-service lint`
  - `pnpm --filter @telemetry/auth-service typecheck`

## 4. Technical implementation steps
1. Add auth cookie and CSRF constants:
   - cookie name, path, max-age, same-site, secure policy, httpOnly.
   - CSRF header/cookie names and helper constants.
2. Extend env/config where needed:
   - explicit cookie security toggles and same-site defaults suitable for dev/prod.
3. Implement cookie helpers in auth-service:
   - set refresh cookie.
   - clear refresh cookie.
   - parse refresh cookie from requests.
4. Update controllers/service contract:
   - login: remove refresh token from response body, set cookie instead.
   - refresh: read token from cookie, rotate and set new cookie.
   - logout: clear cookie in response while preserving revoke behavior.
5. Add CSRF checks for refresh/logout:
   - require CSRF header token match strategy for cookie-authenticated requests.
6. Update tests:
   - assert `set-cookie` behavior for login/refresh/logout.
   - assert `401` on missing/invalid cookie token and CSRF failures.
   - keep existing positive auth/session flows green.

## 5. Validation plan
- First focused validation: auth-service tests.
- Then auth-service lint and typecheck.
- Confirm login/refresh/logout behavior remains stable for existing clients where expected.

## 6. Risks and mitigations
- Risk: breaking current frontend contract that expects refresh token in JSON body.
  - Mitigation: coordinate web client update in same task or introduce temporary compatibility flag.
- Risk: CSRF gaps when switching to cookie transport.
  - Mitigation: enforce explicit CSRF checks and add negative tests.
- Risk: local dev failures due to strict cookie flags.
  - Mitigation: environment-aware secure/same-site settings with explicit defaults.
- Risk: cross-origin gateway/web deployment cookie scope mismatch.
  - Mitigation: document domain/path/same-site requirements and verify via smoke tests.

## 7. Pending tasks with state
- [done] Add cookie and CSRF constants/config
- [done] Implement refresh-cookie helpers
- [done] Refactor login/refresh/logout controller behavior
- [done] Add CSRF enforcement for cookie session endpoints
- [done] Update smoke tests for cookie lifecycle
- [done] Run auth-service test/lint/typecheck
- [in-progress] Summarize outcomes and request commit approval

## 8. Dependencies and sequencing
- Depends on completion of T-022 for shared JWT verification plugin hardening.
- Execute immediately after T-022 is completed and approved.

## 9. Approval gate
- Implementation starts only after explicit user approval.
