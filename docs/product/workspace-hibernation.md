# Project and workspace hibernation

Hibernate project saves that project's tabs and resumable agent session references, then closes its processes. Other open projects continue to use the same workspace. If every project is asleep or closed, automatic shutdown releases this IDE's lease and stops compute only when no other IDE has a live lease.

Hibernate workspace is available beside the workspace selector and in its Tools section. It asks for confirmation, saves every open project, releases project resources, and requests shutdown through the authenticated external control plane. A failed snapshot or changed project list prevents shutdown. It explicitly stops jobs belonging to other connected users as well; this is an owner-authorized workspace action.

The IDE shows Stopping until the external provider reports stopped. Accepted requests and disconnected terminals are not proof that compute stopped. Unknown state or a ten-minute timeout produces an error without claiming success. Transport failures cannot overwrite the intentional shutdown status with Reconnecting. Waking a project resumes compute and waits for workspace services before restoring tabs.

Files and account settings remain on persistent volumes. Hibernation saves session references and editor layout, not a memory image of every process. Running jobs stop; resumable CLI sessions are reopened on wake.

The legacy Shoaib EC2 connection uses the same project lifecycle and external provider observation, with owner-bound five-minute connection leases renewed every thirty seconds while active.
