import { FormEvent, useState } from "react";
import { ChatMessage } from "../types";

interface ChatPanelProps {
  messages: ChatMessage[];
  canSend: boolean;
  onSend: (text: string) => void;
}

export function ChatPanel({ messages, canSend, onSend }: ChatPanelProps): JSX.Element {
  const [draft, setDraft] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !canSend) {
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
          placeholder={canSend ? "Type a message" : "Connect to peer to chat"}
          disabled={!canSend}
        />
        <button type="submit" disabled={!canSend}>
          Send
        </button>
      </form>
    </section>
  );
}
