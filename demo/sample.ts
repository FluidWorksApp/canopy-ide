// LSP test file: expect diagnostics, hover, completion, go-to-definition.

export interface Greeting {
  name: string;
  language: "en" | "hi" | "fr";
}

export function greet(greeting: Greeting): string {
  const prefix =
    greeting.language === "en"
      ? "Hello"
      : greeting.language === "hi"
        ? "Namaste"
        : "Bonjour";
  return `${prefix}, ${greeting.name}!`;
}

// Deliberate type error — the LSP should underline this:
const broken: Greeting = { name: 42, language: "de" };

console.log(greet({ name: "world", language: "en" }));
