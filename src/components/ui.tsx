import { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  className,
  children,
  ...props
}: ButtonProps) {
  const baseClasses =
    'font-medium rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

  const variantClasses = {
    primary: 'bg-slate-900 text-white hover:bg-slate-800',
    secondary: 'border border-slate-300 text-slate-700 hover:bg-slate-50',
    danger: 'bg-red-600 text-white hover:bg-red-700',
  };

  const sizeClasses = {
    sm: 'px-2 py-1 text-sm',
    md: 'px-4 py-2 text-base',
    lg: 'px-6 py-3 text-lg',
  };

  return (
    <button
      {...props}
      disabled={disabled || loading}
      className={[baseClasses, variantClasses[variant], sizeClasses[size], className]
        .filter(Boolean)
        .join(' ')}
    >
      {loading ? (
        <span className="inline-flex items-center gap-2">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent" />
          Loading...
        </span>
      ) : (
        children
      )}
    </button>
  );
}

interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  required?: boolean;
}

export function TextInput({
  label,
  error,
  required,
  type = 'text',
  className,
  ...props
}: TextInputProps) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label className="text-sm font-medium text-slate-700">
          {label}
          {required && <span className="ml-1 text-red-600">*</span>}
        </label>
      )}
      <input
        type={type}
        {...props}
        className={[
          'rounded-md border px-3 py-2 text-base',
          error
            ? 'border-red-300 bg-red-50 focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-200'
            : 'border-slate-300 focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

interface FormProps extends HTMLAttributes<HTMLFormElement> {
  title?: string;
}

export function Form({
  title,
  children,
  className,
  ...props
}: FormProps) {
  return (
    <form
      {...props}
      className={[
        'rounded-xl border border-slate-200 bg-white p-8 shadow-sm',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {title && <h2 className="mb-6 text-xl font-semibold text-slate-900">{title}</h2>}
      <div className="flex flex-col gap-4">{children}</div>
    </form>
  );
}

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  title?: string;
  subtitle?: string;
}

export function Card({
  title,
  subtitle,
  children,
  className,
  ...props
}: CardProps) {
  return (
    <div
      {...props}
      className={[
        'rounded-lg border border-slate-200 bg-white p-4 shadow-sm',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {title && <h3 className="font-semibold text-slate-900">{title}</h3>}
      {subtitle && <p className="mt-1 text-sm text-slate-600">{subtitle}</p>}
      {children && (
        <div className={title || subtitle ? 'mt-4' : ''}>{children}</div>
      )}
    </div>
  );
}

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'success' | 'warning' | 'error' | 'info';
}

export function Badge({
  variant = 'default',
  className,
  children,
  ...props
}: BadgeProps) {
  const variantClasses = {
    default: 'bg-slate-100 text-slate-800',
    success: 'bg-green-100 text-green-800',
    warning: 'bg-yellow-100 text-yellow-800',
    error: 'bg-red-100 text-red-800',
    info: 'bg-blue-100 text-blue-800',
  };

  return (
    <span
      {...props}
      className={[
        'inline-block rounded-full px-3 py-1 text-xs font-medium',
        variantClasses[variant],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </span>
  );
}

interface StatusBadgeProps {
  status: 'online' | 'idle' | 'offline';
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const statusConfig = {
    online: { variant: 'success' as const, label: 'Online' },
    idle: { variant: 'warning' as const, label: 'Idle' },
    offline: { variant: 'error' as const, label: 'Offline' },
  };

  const config = statusConfig[status];
  return <Badge variant={config.variant}>{config.label}</Badge>;
}
