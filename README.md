```
cd functions
nvm use 20
npm install
npm test
firebase deploy

firebase emulators:start
```

## Production Cloud Tasks setup

`confirmBooking` enqueues overlap cleanup work to Cloud Tasks after the selected booking is confirmed. Production must have this queue before booking confirmation can report `phase2: "enqueued"`.

Required queue path:

```
projects/lend-54b2e/locations/us-central1/queues/decline-overlapping-bookings
```

Create and verify the queue:

```sh
gcloud services enable cloudtasks.googleapis.com --project=lend-54b2e

gcloud tasks queues create decline-overlapping-bookings \
  --project=lend-54b2e \
  --location=us-central1

gcloud tasks queues describe decline-overlapping-bookings \
  --project=lend-54b2e \
  --location=us-central1
```

Required production configuration:

```sh
DECLINE_FUNCTIONS_URL=https://<deployed-declineOverlappingBookings-url>
TASKS_SERVICE_ACCOUNT_EMAIL=<service-account-used-for-cloud-tasks-oidc>
```

IAM requirements:

- The service account running `confirmBooking` needs `roles/cloudtasks.enqueuer` for the queue project.
- The `TASKS_SERVICE_ACCOUNT_EMAIL` service account must be allowed to invoke `declineOverlappingBookings`.

Operational check:

- A successful booking confirmation should return `phase2: "enqueued"`.
- Function logs should include `[enqueueDeclineTask] Created task: ...`.
- `declineOverlappingBookings` logs should show the task payload being processed.
