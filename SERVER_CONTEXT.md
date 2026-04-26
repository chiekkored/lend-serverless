# Lend Serverless Backend Context

## 1. Executive Summary

This repository is a narrow Firebase Cloud Functions backend for critical booking and QR handoff flows in Lend, a peer-to-peer rental marketplace. It currently acts as a partial authority for booking confirmation, QR token generation, QR verification, return/handover marking, and some chat-side system messaging.

The implementation is materially smaller than the intended product scope. There are no payment handlers, admin workflows, fraud modules, HTTP APIs for public clients, Firestore rules, or active scheduled jobs in this repo. The real backend surface today is:

- confirm a booking
- generate or regenerate QR tokens
- verify QR tokens
- mark handover/return complete
- asynchronously decline overlapping pending bookings
- send system chat messages as booking side effects

The code shows a backend that is directionally correct in one important way: critical booking confirmation is server-side, not purely client-side. But it is not yet production-grade. The largest issues are weak authorization, broken Cloud Tasks payload handling, duplicated booking state across two Firestore locations, inconsistent status/schema conventions, and a token verification path that is weaker than the token inspection path.

## 2. Architecture Overview

### Repository Shape

- `functions/index.js`: deployment entrypoint and export registry
- `functions/calls/*`: callable functions and one HTTP task handler
- `functions/utils/*`: token signing, chat side effects, error helper
- `functions/scheduled/syncUserMetadata.js`: designed scheduled job, currently commented out
- `firebase.json`: functions source and emulator config
- `storage.rules`: Cloud Storage rules

### Runtime and Deployment Style

- Node.js `22` runtime declared in [`functions/package.json`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/package.json:1)
- CommonJS JavaScript, not TypeScript
- Firebase Functions v1-style APIs via `functions.https.onCall` and `functions.https.onRequest`
- Firebase Admin initialized once with application default credentials in [`functions/index.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/index.js:11)
- Default Firebase project is `lend-54b2e` in [`.firebaserc`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/.firebaserc:1)

### Config and Environment

- `QR_SECRET` is required at module load time by token-related functions and `token.util`
- `GCP_PROJECT` is required indirectly for Cloud Tasks enqueue URL/path generation in [`functions/calls/confirmBooking.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/calls/confirmBooking.js:148)
- Functions call `dotenv.config()`, implying local `.env` usage; no production config strategy is documented

### Active vs Inactive Backend Surface

Active exports in [`functions/index.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/index.js:16):

- `makeToken`
- `verifyAndMark`
- `regenerateToken`
- `verifyToken`
- `confirmBooking`
- `declineOverlappingBookings`

Inactive but present:

- `syncUserMetadata` is imported but not exported; the implementation itself is fully commented out in [`functions/scheduled/syncUserMetadata.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/scheduled/syncUserMetadata.js:13)

## 3. Function Registry

### `makeToken`

Source: [`functions/calls/makeToken.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/calls/makeToken.js:14)

Purpose:

- Generates signed handover and return QR tokens for a booking
- Stores them into both booking copies:
  - `users/{userId}/bookings/{bookingId}`
  - `assets/{assetId}/bookings/{bookingId}`

Observed behavior:

- Requires auth, but does not verify caller role or ownership
- Trusts caller-provided `userId`, `assetId`, `bookingId`
- Reads booking only from the asset-side booking doc
- Uses `endDate` as the basis for both handover and return token expiry

### `regenerateToken`

Source: [`functions/calls/regenerateToken.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/calls/regenerateToken.js:18)

Purpose:

- Rotates booking QR tokens and overwrites prior tokens in both booking copies

Observed behavior:

- Requires auth, but no authorization beyond that
- Allows token regeneration unless `returned.status === true`
- Does not check booking status, booking participant, or ownership
- Overwrites the full `tokens` object with fewer fields than `makeToken`

### `verifyToken`

Source: [`functions/calls/verifyToken.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/calls/verifyToken.js:18)

Purpose:

- Validates a QR token without mutating booking state

Observed behavior:

- Requires auth
- Verifies HMAC signature
- Verifies token expiry
- Reads asset-side booking doc
- Compares the full token string against the token stored in Firestore
- Uses `handoverAt` / `returnedAt` completion checks that are inconsistent with actual mutation logic elsewhere

### `verifyAndMark`

Source: [`functions/calls/verifyAndMark.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/calls/verifyAndMark.js:13)

Purpose:

- Verifies a QR token and marks either handover or return complete
- Appends booking events
- Sends system chat messages
- Sends rating prompt after return
- Archives owner chat after return

Observed behavior:

- Requires auth, but no role check
- Verifies token signature and expiry
- Does not compare the presented token against the stored booking token
- Has the token UUID consistency check commented out
- Writes boolean status objects under `handedOver` or `returned`

### `confirmBooking`

Source: [`functions/calls/confirmBooking.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/calls/confirmBooking.js:18)

Purpose:

- Confirms one booking atomically
- Writes a system confirmation message into chat
- Updates renter and owner `userChats`
- Enqueues an async cleanup to decline overlapping pending bookings

Observed behavior:

- Requires auth, but does not verify that caller is asset owner or admin
- Trusts caller-provided `bookingId`, `assetId`, `renterId`
- Checks only that asset-side booking status is `"Pending"`
- Updates both duplicated booking docs to `"Confirmed"`
- Uses a two-phase model:
  - phase 1: synchronous transaction for selected booking
  - phase 2: async Cloud Task for overlap cleanup

### `declineOverlappingBookings`

Source: [`functions/calls/declineOverlappingBookings.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/calls/declineOverlappingBookings.js:14)

Purpose:

- HTTP endpoint intended for Cloud Tasks
- Finds overlapping pending bookings for an asset and declines them

Observed behavior:

- Accepts `POST` only
- Expects Pub/Sub-style payload shape `request.body.message.data`
- Queries `assets/{assetId}/bookings` for overlapping `"Pending"` docs
- Batch-updates asset booking, user booking, and renter chat metadata
- Does not send decline chat messages or notify owner chat

### `sendSystemChatMessage`

Source: [`functions/utils/chat.util.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/utils/chat.util.js:3)

Purpose:

- Reusable helper to write a system chat message and update `userChats` metadata

Observed behavior:

- Always updates `lastMessage` metadata when the included side is enabled
- The `includeLastMessage` argument is unused

### `throwAndLogHttpsError`

Source: [`functions/utils/error.util.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/utils/error.util.js:10)

Purpose:

- Logs and throws Firebase `HttpsError`

Observed behavior:

- Logs serialized details
- Frequently used with raw internal error messages

### `syncUserMetadata` (inactive)

Source: [`functions/scheduled/syncUserMetadata.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/scheduled/syncUserMetadata.js:1)

Intended purpose:

- Daily denormalized user metadata repair across bookings and chats

Reality:

- Not exported
- Entire implementation is commented out
- No scheduled job is deployed from this repository

## 4. Firestore Write Map

### Collections and Subcollections Actually Used

- `users/{uid}`
- `users/{uid}/bookings/{bookingId}`
- `users/{uid}/bookings/{bookingId}/events/{eventId}`
- `assets/{assetId}/bookings/{bookingId}`
- `assets/{assetId}/bookings/{bookingId}/events/{eventId}`
- `chats/{chatId}/messages/{messageId}`
- `userChats/{uid}/chats/{chatId}`

### Function-by-Function Read/Write Map

| Function | Reads | Writes |
|---|---|---|
| `makeToken` | `assets/{assetId}/bookings/{bookingId}` | `users/{userId}/bookings/{bookingId}`, `assets/{assetId}/bookings/{bookingId}` |
| `regenerateToken` | `assets/{assetId}/bookings/{bookingId}`, both booking copies in transaction | `users/{userId}/bookings/{bookingId}`, `assets/{assetId}/bookings/{bookingId}` |
| `verifyToken` | `assets/{assetId}/bookings/{bookingId}` | none |
| `verifyAndMark` | both booking copies | both booking copies, both `events` subcollections, `chats/{chatId}/messages`, owner/renter `userChats`, then owner `userChats` archive on return |
| `confirmBooking` | `assets/{assetId}/bookings/{bookingId}` | both booking copies, `chats/{chatId}/messages/{messageId}`, renter `userChats`, owner `userChats` |
| `declineOverlappingBookings` | query over `assets/{assetId}/bookings` | matching asset bookings, matching user bookings, renter `userChats` |
| `syncUserMetadata` inactive | `users`, `users/{uid}/bookings`, `collectionGroup(bookings)`, `userChats/{uid}/chats` | same documents when stale |

### Data Model Implication

The backend duplicates booking state in two locations:

- asset-centric copy for inventory/availability logic
- user-centric copy for renter-facing views

This is common for mobile feed/query ergonomics, but it creates immediate consistency risk because every critical mutation must update both copies correctly every time.

## 5. Booking Engine Analysis

### Current Booking Flow

#### Booking Confirmation

Likely mobile flow:

1. User action triggers callable `confirmBooking`
2. Backend reads `assets/{assetId}/bookings/{bookingId}`
3. Transaction checks `status === "Pending"`
4. Backend updates both booking copies to `"Confirmed"`
5. Backend creates a system chat message
6. Backend updates renter and owner `userChats`
7. Backend attempts to enqueue overlap cleanup task
8. Client receives success immediately even if overlap cleanup later fails

Strength:

- Confirmation itself is server-side and transactional across the two booking copies plus chat metadata

Weakness:

- Authorization is missing, so any authenticated user who knows identifiers can call it
- The overlap cleanup phase is not part of the same consistency boundary

### Overlap Prevention Model

The intended model is:

- confirm one selected booking immediately
- decline all overlapping pending bookings asynchronously

This is a reasonable scaling direction in principle. Large overlap fanout should not live inside the same Firestore transaction as the chosen confirmation.

But the current implementation fails operationally:

1. `confirmBooking` sends a raw JSON body in the Cloud Task request in [`functions/calls/confirmBooking.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/calls/confirmBooking.js:159)
2. `declineOverlappingBookings` expects `request.body.message.data`, which is a Pub/Sub push envelope, not a raw Cloud Tasks HTTP payload, in [`functions/calls/declineOverlappingBookings.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/calls/declineOverlappingBookings.js:25)
3. Result: the task handler will treat valid task requests as malformed and return `400 No message`

Impact:

- the chosen booking becomes `"Confirmed"`
- overlapping pending bookings remain pending
- the inventory can still look available to other pending flows
- manual cleanup is required

This is the single biggest integrity bug in the booking engine.

### Status Lifecycle Actually Implemented

Implemented statuses/markers found in code:

- `"Pending"`
- `"Confirmed"`
- `"Declined"`
- chat status `"Archived"`
- chat status `"archived"`
- `handedOver.status === true`
- `returned.status === true`

The richer lifecycle from the product brief is not implemented in this repository. There is no authoritative server-side model for:

- `ready_for_pickup`
- `active`
- `return_pending`
- `completed`
- `cancelled`
- `declined` in lowercase

Conclusion:

The booking engine is only partially centralized. Confirmation and handover/return markers are server-managed, but the broader lifecycle contract is absent. If the mobile app currently manages more status transitions directly, this backend is not yet the sole source of truth.

## 6. QR / Token Trust System

### Current Design

Token payload fields:

- `bookingId`
- `userId`
- `assetId`
- `action`
- `uuid`
- `expiresAt`

Token format:

- base64 JSON payload
- `.` separator
- HMAC-SHA256 signature using `QR_SECRET`

Creation is centralized via `createSignedToken` in [`functions/utils/token.util.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/utils/token.util.js:6).

### Actual Trust Model by Function

#### `verifyToken`

This is the stronger validation path.

It checks:

- auth present
- signature valid
- payload decodes
- payload fields present
- not expired
- booking exists
- full presented token equals the stored Firestore token

This is good. It prevents stale or replaced tokens from passing validation.

#### `verifyAndMark`

This is the weaker mutation path.

It checks:

- auth present
- signature valid
- payload decodes
- fields present
- not expired
- booking exists
- booking has a `tokens` object
- action not already marked

It does **not** check:

- the full token matches the current Firestore token
- the UUID matches current booking token state
- the caller is authorized to perform the action
- the booking is in the correct lifecycle state for this action

The UUID verification code is explicitly commented out in [`functions/calls/verifyAndMark.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/calls/verifyAndMark.js:84).

### Critical Trust Problem

The read-only token validation function is stricter than the state-mutating verification function.

That is backwards.

A validly signed but outdated token can fail `verifyToken` and still pass `verifyAndMark` if its payload is syntactically valid and not expired. That means rotate/regenerate semantics are not reliably enforced on the mutation path.

### Token Expiry Concerns

`makeToken` and `regenerateToken` both compute:

- `handoverExpiry = endDate`
- `returnExpiry = endDate + 3 days`

Using `endDate` for handover expiry is suspicious. Handover usually occurs at or before booking start, not at booking end. This suggests either:

- the product semantics are different than the naming implies, or
- the token windows are wrong

## 7. Security Audit

### 1. Authorization Is Largely Missing

All active callables only check `request.auth`, not caller entitlement.

Examples:

- `confirmBooking` does not verify the caller owns the asset or has an admin role
- `makeToken` does not verify the caller is the booking renter, owner, or system actor
- `regenerateToken` does not verify booking participant or owner
- `verifyAndMark` does not verify who is allowed to mark handover or return
- `verifyToken` reveals booking-linked token validity to any authenticated caller holding a token

This means identity is authenticated, but authority is not enforced.

### 2. Caller-Controlled Identifiers Are Trusted

Multiple functions accept `userId`, `assetId`, `renterId`, `bookingId` directly from the client and interpolate them into Firestore paths without cross-checking against `auth.uid`.

That is an abuse vector for:

- generating tokens for someone else’s booking
- confirming someone else’s booking
- reading booking-token validity on bookings unrelated to the caller

### 3. HTTP Task Endpoint Is Not Authenticated

`declineOverlappingBookings` only checks request method in [`functions/calls/declineOverlappingBookings.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/calls/declineOverlappingBookings.js:16).

It does not verify:

- Cloud Tasks headers
- OIDC token
- calling service account
- any signed secret

If the endpoint URL is reachable, it is effectively open to arbitrary POSTs.

### 4. Storage Rules Are Fully Open

[`storage.rules`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/storage.rules:7) contains:

- `allow read, write: if true;`

This is a severe production risk. Any internet client with the bucket path can read or write objects unless infrastructure outside this repo blocks it.

### 5. Internal Error Leakage

`confirmBooking` catches and rethrows `error.message` as an `internal` HttpsError in [`functions/calls/confirmBooking.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/calls/confirmBooking.js:136).

This leaks raw internal failure text to clients and makes the public error contract unstable.

### 6. No Abuse Controls

There is no evidence of:

- App Check enforcement
- per-user rate limiting
- replay protection beyond token expiry and limited state checks
- audit correlation IDs
- admin override logging

## 8. Reliability Audit

### 1. Broken Cloud Tasks Contract

This is the top reliability issue.

Enqueued payload shape does not match handler expectations. Overlap cleanup is therefore likely dead on arrival.

### 2. Inconsistent State Schema

`verifyAndMark` writes:

- `handedOver.status`
- `returned.status`

But `verifyToken` checks:

- `booking.handoverAt`
- `booking.returnedAt`

So the verification function can report a token as valid even after `verifyAndMark` already completed that action, depending on actual stored fields.

### 3. Partial Side-Effect Failures After Booking Mutation

`verifyAndMark` commits booking mutation first, then sends chat messages, then runs another transaction to archive owner chat on return.

If a post-transaction chat write fails:

- booking state is mutated
- event logs are written
- UX messaging is missing or partially missing

The code has no compensating action or retry queue.

### 4. Misleading Function Result Contract

`confirmBooking` returns:

- `phase1: "completed"`
- `phase2: "enqueued"`

even if enqueue fails, because the return payload is static after the warning path. That is inaccurate operational reporting.

### 5. Non-Idempotent or Weakly Idempotent Side Effects

- `verifyAndMark` blocks repeat marking by checking existing boolean status, which is acceptable
- chat system messages are not deduplicated by business key
- return flow emits multiple side effects without durable orchestration
- overlap decline retries are intended to come from Cloud Tasks, but because payload parsing is broken, that safety net is not functioning

### 6. Batch Failure Fragility

`declineBooking` assumes:

- user booking doc exists
- renter chat doc exists

If one is missing, the whole batch for that booking fails. The task continues, but the single booking remains pending.

## 9. Scalability Audit

### What Is Reasonable

- Two-phase confirmation is a scalable direction
- Duplicated booking docs can be acceptable for mobile query efficiency if consistency is strictly controlled
- Async overlap fanout is better than loading many overlaps into one transaction

### What Will Break Under Load

#### 1. Overlap Query Depends on Correct Compound Indexing

`declineOverlappingBookings` performs a multi-field range/equality query on `startDate`, `endDate`, and `status`. That likely needs a composite index, but no `firestore.indexes.json` exists in repo.

Risk:

- production failures or console-generated ad hoc indexes outside source control

#### 2. User Metadata Sync Design Is Full-Scan Heavy

If the commented scheduler is ever enabled as written, it will:

- scan all users
- run per-user booking queries
- run per-user collection group queries
- scan each user’s chats

That is not startup-scale fatal at tiny size, but it will become costly and slow quickly.

#### 3. Cold Start and Package Simplicity

The current codebase is small and unlikely to suffer severe cold start issues from code size alone. The bigger issue is not latency from code bulk; it is correctness and auth.

#### 4. No Clear Gen2 Strategy

The code uses `firebase-functions` `6.6.0`, but the implementation style remains older `functions.https.onCall` / `onRequest`. There is no evidence of concurrency tuning, region tuning, memory tuning, or Gen2-specific operational hardening.

## 10. Inconsistencies With Mobile App

This section is backend-inferred only. The mobile repository is not present here, so these are mismatch risks, not source-proven frontend bugs.

### Likely Contract Risks

#### 1. Status Casing Drift

Backend uses:

- `"Pending"`
- `"Confirmed"`
- `"Declined"`
- `"Archived"`

The product brief uses lowercase lifecycle names like `pending`, `confirmed`, `cancelled`, `completed`.

If the app expects lowercase enum values, this backend will drift.

#### 2. Booking Completion Field Drift

`verifyAndMark` writes `handedOver.status` / `returned.status`, while `verifyToken` checks `handoverAt` / `returnedAt`.

If the app depends on one shape and the backend writes another, UI state and callable validation will disagree.

#### 3. Chat Archive Status Drift

Overlap decline writes `status: "Archived"` in [`functions/calls/declineOverlappingBookings.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/calls/declineOverlappingBookings.js:146), while return flow writes `status: "archived"` in [`functions/calls/verifyAndMark.js`](/Users/chiekkoredalino/Projects/Flutter Projects/lend-serverless/functions/calls/verifyAndMark.js:157).

That is a direct schema inconsistency inside the backend and likely to produce client branching bugs.

#### 4. Scheduled Sync Expectations

The code comments describe a daily metadata sync design, but it is not deployed. If the app assumes automatic denormalized profile repair, that assumption is false today.

#### 5. Callable Surface Is Smaller Than Product Surface

The backend exports only:

- `makeToken`
- `verifyAndMark`
- `regenerateToken`
- `verifyToken`
- `confirmBooking`

If the mobile app expects backend-authoritative cancellation, payment confirmation, booking completion, admin moderation, or notifications, those functions do not exist in this repository.

## 11. Recommended Refactor Plan

### Priority 0: Fix Integrity Breakers Immediately

1. Fix Cloud Tasks payload contract and secure the HTTP task endpoint with OIDC/service-account verification.
2. Make `verifyAndMark` at least as strict as `verifyToken`:
   - compare full token against Firestore
   - restore UUID/current-token validation
   - enforce booking state preconditions
3. Add real authorization checks to every callable:
   - asset owner only for confirmation
   - participant/role-based checks for token generation and verification

### Priority 1: Consolidate Booking State Authority

4. Define a single canonical booking lifecycle enum and use it everywhere.
5. Normalize status casing and field naming.
6. Replace ad hoc booleans like `handedOver.status` with explicit lifecycle transitions plus timestamps and actor IDs.
7. Keep duplicated booking docs if needed, but define one canonical write service and one schema contract.

### Priority 2: Harden Operational Reliability

8. Make function return payloads truthful about async outcomes.
9. Introduce structured logging with correlation IDs: bookingId, assetId, renterId, taskId, actorId.
10. Move post-transaction side effects into durable async jobs where partial failure matters.
11. Add idempotency strategy for chat-side business events.

### Priority 3: Lock Down Security Posture

12. Replace open `storage.rules` with authenticated, path-scoped, ownership-aware rules.
13. Add Firestore rules to repo if they exist elsewhere; if not, create and source-control them.
14. Document production secret/config management instead of relying on implicit `.env` habits.
15. Add App Check or other abuse controls for callable access.

### Priority 4: Source-Control Backend Operations

16. Add `firestore.indexes.json` for overlap queries and any upcoming booking lifecycle queries.
17. Rework or remove `syncUserMetadata`; if kept, redesign it around targeted updates rather than full scans.

## 12. Future Production Blueprint

### Target Architecture

The backend should evolve into a startup-grade authoritative booking platform with these properties:

- backend-owned lifecycle transitions
- explicit role enforcement
- consistent booking schema
- durable async jobs for non-critical fanout
- strong observability and replay safety

### Recommended Direction

#### Authoritative Booking Service

Create one booking domain layer responsible for:

- creation
- confirmation
- cancellation
- handover
- activation
- return
- completion
- overlap resolution

No frontend should write critical lifecycle state directly.

#### Canonical Data Contract

Define:

- one booking status enum
- one event/audit model
- one token model
- one participant/role model

Then apply it consistently to both asset and user booking mirrors.

#### Secure Token System

Move from “signed payload only” to:

- signed payload
- stored current token/version
- role-based verifier authorization
- lifecycle precondition checks
- replay-safe event logging

#### Async Processing

Use Cloud Tasks or Pub/Sub intentionally:

- overlap cleanup
- notifications
- ratings prompts
- denormalized metadata repairs
- reminder workflows

Each async path should have:

- authenticated invocation
- idempotent handlers
- retry-safe payloads
- monitoring and alerting

#### Observability

Add:

- structured logs
- per-flow correlation IDs
- error classes
- metrics on booking transitions and task failures
- dead-letter or failure review workflow for async jobs

### CTO View

This backend is not a lost cause. It already centralizes some of the right responsibilities. But it is currently a prototype-grade authority layer, not a production-trustworthy one. The fastest path to maturity is not adding more features first. It is locking down authorization, fixing the overlap job contract, unifying lifecycle schema, and making the token mutation path trustworthy.

