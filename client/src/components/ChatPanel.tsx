import { FormEvent, useState } from "react";
import { ChatMessage } from "../types";

interface ChatPanelProps {
  messages: ChatMessage[];
  onSend: (text: string) => void;
}

export function ChatPanel({ messages, onSend }: ChatPanelProps): JSX.Element {
  const [draft, setDraft] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) {
      return;
    }

    onSend(text);
    setDraft("");
  };

  return (
    <section className="card chat">
      <h2>Chat</h2>
      <div className="messages">
        {messages.length === 0 ? <p className="empty">No messages yet</p> : null}
        {messages.map((message) => (
          <article key={message.id} className={message.own ? "message own" : "message"}>
            <header>
              <strong>{message.author}</strong>
              <span>{message.sentAt}</span>
            </header>
            <p>{message.text}</p>
          </article>
        ))}
      </div>

      <form className="chat-input" onSubmit={submit}>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Type a message"
        />
        <button type="submit">
          Send
        </button>
      </form>
    </section>
  );
}
