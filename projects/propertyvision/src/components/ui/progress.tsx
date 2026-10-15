import * as React from 'react';

import { cn } from '@/lib/utils';

interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number;
}

const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(({ className, value = 0, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('relative h-2 w-full overflow-hidden rounded-full bg-slate-200/70', className)}
    {...props}
  >
    <div
      className="h-full w-full origin-left scale-x-0 rounded-full transition-transform duration-500"
      style={{
        transform: `scaleX(${Math.min(100, Math.max(0, value)) / 100})`,
        backgroundColor: '#10b981'
      }}
    />
  </div>
));
Progress.displayName = 'Progress';

export { Progress };
