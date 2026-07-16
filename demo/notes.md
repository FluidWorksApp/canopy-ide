# Demo notes

This file tests the **native Markdown renderer**.

## Features

- *italics*, **bold**, `inline code`
- [links](https://example.com)
- tables:

| Feature | Status |
|---------|--------|
| Terminal | ✅ |
| Diff-first | ✅ |
| Viewers | ✅ |

## Mermaid diagram

```mermaid
flowchart LR
    A[Agent edits file] --> B{IDE watcher}
    B --> C[Diff view]
    B --> D[Changes panel]
    C --> E[Accept / Keep mine]
```

## Code block

```typescript
export function greet(name: string): string {
  return `hello ${name}`;
}
```
