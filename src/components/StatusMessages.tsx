import { useUIStore } from '../store/useUIStore';

export function StatusMessages() {
  const { statusMessages } = useUIStore();

  if (statusMessages.length === 0) {
    return null;
  }

  return (
    <div className="fixed right-6 top-6 z-50 flex max-w-sm flex-col gap-3">
      {statusMessages.map((message) => {
        const typeConfig = {
          info: { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-900' },
          success: {
            bg: 'bg-green-50',
            border: 'border-green-200',
            text: 'text-green-900',
          },
          warning: {
            bg: 'bg-yellow-50',
            border: 'border-yellow-200',
            text: 'text-yellow-900',
          },
          error: { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-900' },
        };

        const config = typeConfig[message.type];

        return (
          <div
            key={message.id}
            className={`rounded-lg border ${config.bg} ${config.border} ${config.text} px-4 py-3 text-sm shadow-md`}
          >
            {message.message}
          </div>
        );
      })}
    </div>
  );
}
