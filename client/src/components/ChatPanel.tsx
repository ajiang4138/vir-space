import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { ChatMessage } from "../types";

interface ChatPanelProps {
  messages: ChatMessage[];
  onSend: (text: string) => void;
}

export function ChatPanel({ messages, onSend }: ChatPanelProps): JSX.Element {
  const [draft, setDraft] = useState("");
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) {
      return;
    }

    container.scrollTop = container.scrollHeight;
  }, [messages]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }

    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }, [draft]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) {
      return;
    }

    onSend(text);
    setDraft("");
  };

  const handleDraftKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const text = draft.trim();
      if (!text) {
        return;
      }

      onSend(text);
      setDraft("");
    }
  };

  return (
    <section className="card chat">
      <h2>Chat</h2>
      <div className="messages" ref={messagesContainerRef}>
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
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleDraftKeyDown}
          placeholder="Type a message"
        />
        <button type="submit" className="chat-send-button" aria-label="Send message" title="Send">
          <svg viewBox="0 0 24 24" role="img" aria-hidden="true" focusable="false">
            <path d="M3 11.5L20.5 3L14.5 21L11.5 13L3 11.5Z" fill="currentColor" />
          </svg>
        </button>
      </form>
    </section>
  );
}
