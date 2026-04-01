import { useNavigate } from 'react-router-dom';
import { useUIStore } from '../store/useUIStore';

export function LandingPage() {
  const navigate = useNavigate();
  const { currentPeerName, systemStatus } = useUIStore();

  return (
    <div className="mx-auto max-w-2xl">
      <section className="rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <h2 className="mb-2 text-3xl font-bold text-slate-900">Welcome to Vir Space</h2>
        <p className="mb-6 text-lg text-slate-600">
          A peer-to-peer virtual workspace for real-time collaboration
        </p>

        {currentPeerName && (
          <div className="mb-6 rounded-lg bg-blue-50 p-4">
            <p className="text-sm text-blue-900">
              <span className="font-semibold">Connected as:</span> {currentPeerName}
            </p>
          </div>
        )}

        <div className="mb-8 rounded-lg bg-slate-50 p-6">
          <h3 className="mb-3 font-semibold text-slate-900">Getting Started</h3>
          <p className="mb-4 text-slate-700">
            Create a private room for your team or join an existing room with a room ID or invite code.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <button
            onClick={() => navigate('/create-room')}
            className="flex flex-col items-start gap-3 rounded-lg border border-slate-300 bg-white p-6 transition hover:bg-slate-50 hover:shadow-md"
          >
            <div className="text-2xl">✨</div>
            <h4 className="font-semibold text-slate-900">Create Room</h4>
            <p className="text-sm text-slate-600">
              Start a new private collaborative workspace
            </p>
          </button>

          <button
            onClick={() => navigate('/join-room')}
            className="flex flex-col items-start gap-3 rounded-lg border border-slate-300 bg-white p-6 transition hover:bg-slate-50 hover:shadow-md"
          >
            <div className="text-2xl">🚪</div>
            <h4 className="font-semibold text-slate-900">Join Room</h4>
            <p className="text-sm text-slate-600">
              Join with a room ID or invite code
            </p>
          </button>
        </div>

        <div className="mt-8 rounded-lg border-l-4 border-slate-400 bg-slate-50 p-4">
          <p className="text-sm text-slate-600">
            <span className="font-semibold">System Status:</span>{' '}
            <span className="capitalize">{systemStatus}</span>
          </p>
        </div>
      </section>
    </div>
  );
}
