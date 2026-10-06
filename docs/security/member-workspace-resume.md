# Shared workspace Resume

Developers and administrators with a current writable project grant can explicitly
resume a previously enabled shared workspace. A broad viewer grant cannot supply
write access, and an empty project selection cannot authorize a wake. Removing
organization membership also removes direct and team authorization.

The account service accepts only Resume and advance-existing-Resume for guests.
Stop, Delete, Resize, package changes and billing remain owner controls. Guest
request payloads are reduced to a resume action and server-derived request key;
owner, plan, generation and operation-context overrides are ignored. The lifecycle
operation remains funded by the workspace owner, records the actual requester and
binds replay keys to that requester and workspace. Already-ready Resume is a no-op
and cannot increment the generation or add a billable operation.

An active Resume is joined rather than replaced. An interrupted Resume can retry
its existing phase and resource context under the worker's advisory lock, retaining
its generation and recording the retry requester/key. Other interrupted operation
types require owner recovery. Guest advance is bound to the exact checked operation
ID and rechecks the resume action before any provider or state mutation.

Discovery exposes separate Connect, Write and Resume capabilities. The IDE offers
Resume to eligible members and explains that running time is billed to the owner.
Background list polling does not request Resume or advance operations; startup
progress runs only after an explicit user action. Viewer connections retain view
scope and cannot wake a stopped workspace. Following resume, member connections
remain gated until the new management runtime proves sharing readiness for the
current generation.

Implementation tests use synthetic database/provider clients. No real workspace
was resumed or changed to exercise these paths.
