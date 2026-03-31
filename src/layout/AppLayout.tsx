import { NavLink, Outlet } from 'react-router-dom';

const navItems = [
  { to: '/', label: 'Landing' },
  { to: '/create-room', label: 'Create Room' },
  { to: '/discover-room', label: 'Discover Room' },
  { to: '/join-room', label: 'Join Room' },
  { to: '/workspace', label: 'Workspace' },
  { to: '/shared-files', label: 'Shared Files' },
  { to: '/peer-presence', label: 'Peer Presence' },
];

export function AppLayout() {
  return (
    <div className="mx-auto flex min-h-screen max-w-7xl flex-col gap-6 p-6">
      <header className="rounded-xl border border-slate-200 bg-white/80 p-5 shadow-sm backdrop-blur">
        <h1 className="text-2xl font-semibold">Vir Space</h1>
        <p className="mt-1 text-sm text-slate-600">
          Desktop peer-to-peer virtual remote workspace scaffold
        </p>
        <nav className="mt-4 flex flex-wrap gap-2">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                [
                  'rounded-md border px-3 py-1.5 text-sm transition',
                  isActive
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400',
                ].join(' ')
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}
