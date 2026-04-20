## Fix approach — INFRA-signup-formfield-mismatch

The previous fix agent's code change (`{ id: "name", optional: true }` in formFields) was correct and is retained. This bug was blocked from verification solely because INFRA-supertokens-cdi-mismatch caused all auth calls to return 500. After resolving the CDI mismatch by downgrading supertokens-node to ^23.1.0, signup with the `name` field succeeds (HTTP 200), and signup without the `name` field also succeeds (since it's optional). No additional code changes needed beyond the CDI fix.
