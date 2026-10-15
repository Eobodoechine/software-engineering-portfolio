import * as React from 'react';
import { AlertTriangle, Info } from 'lucide-react';

import { cn } from '@/lib/utils';

export interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'destructive';
  title?: string;
}

const icons = {
  default: Info,
  destructive: AlertTriangle
};

const baseStyles = 'flex gap-3 rounded-2xl border px-4 py-3 text-sm shadow-sm';

const variants = {
  default: 'border-slate-200 bg-white text-slate-700',
  destructive: 'border-rose-200 bg-rose-50 text-rose-700'
};

const iconVariants = {
  default: 'text-slate-500',
  destructive: 'text-rose-500'
};

export const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className, variant = 'default', title, children, ...props }, ref) => {
    const Icon = icons[variant];
    return (
      <div ref={ref} className={cn(baseStyles, variants[variant], className)} {...props}>
        <Icon className={cn('h-5 w-5 shrink-0', iconVariants[variant])} />
        <div className="space-y-1">
          {title ? <p className="font-semibold text-slate-900">{title}</p> : null}
          <div>{children}</div>
        </div>
      </div>
    );
  }
);
Alert.displayName = 'Alert';
