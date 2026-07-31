// An agent's question to the user (canopy_ask_user), which is the one case
// where the agent is blocked on a person rather than the other way round.
//
// It has no cancel: the agent is holding an open request, so every path out of
// here is an answer. Closing without one would strand it until the bridge's
// timeout — "skip" says so explicitly instead.
import { useState } from "react";
import { Button } from "./ui";

export function AskDialog({
  question,
  options,
  onAnswer,
}: {
  question: string;
  options: string[];
  onAnswer: (answer: string) => void;
}) {
  const [text, setText] = useState("");
  return (
    <div className="confirm-backdrop">
      <div className="confirm ask-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <p className="ask-from">An agent is asking</p>
        <p className="ask-question">{question}</p>
        {options.length > 0 && (
          <div className="ask-options">
            {options.map((option) => (
              <Button className="ask-option" key={option}  onClick={() => onAnswer(option)}>
                {option}
              </Button>
            ))}
          </div>
        )}
        <form
          className="ask-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) onAnswer(text.trim());
          }}
        >
          <input
            autoFocus
            value={text}
            placeholder={options.length ? "…or answer in your own words" : "Your answer"}
            onChange={(e) => setText(e.target.value)}
          />
          <Button variant="accent" type="submit" disabled={!text.trim()}>
            Send
          </Button>
        </form>
        <div className="confirm-actions">
          <Button
            onClick={() => onAnswer("(the user skipped this question — decide for yourself)")}>
            Skip
          </Button>
        </div>
      </div>
    </div>
  );
}
