import type { ReactNode } from "react";

function Svg({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg className={`${className ?? ""} icon`.trim()} viewBox="0 0 24 24" aria-hidden="true">
      {children}
    </svg>
  );
}

const stroke = { className: "iconstroke" } as const;

export function IconSend({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path {...stroke} d="M12 19V5" />
      <path {...stroke} d="M5.5 11 12 4.5 18.5 11" />
    </Svg>
  );
}

export function IconReceive({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path {...stroke} d="M12 5v14" />
      <path {...stroke} d="M5.5 13 12 19.5 18.5 13" />
    </Svg>
  );
}

export function IconFile({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path {...stroke} d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path {...stroke} d="M14 3v5h5" />
    </Svg>
  );
}

export function IconDevice({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <rect {...stroke} x="3" y="4" width="18" height="14" rx="2" />
      <path {...stroke} d="M9 21h6" />
      <path {...stroke} d="M12 18v3" />
    </Svg>
  );
}

export function IconOnline({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path {...stroke} d="M9.5 15.5a5 5 0 0 1 5 0" />
      <path {...stroke} d="M7 12.5a8.5 8.5 0 0 1 10 0" />
      <path {...stroke} d="M4.5 9.5a12 12 0 0 1 15 0" />
      <circle cx="12" cy="19" r="0.6" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconLight({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <rect {...stroke} x="9" y="9" width="6" height="6" rx="1" />
      <path {...stroke} d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5 5l1.4 1.4M17.6 17.6 19 19M19 5l-1.4 1.4M6.4 17.6 5 19" />
    </Svg>
  );
}

export function IconSound({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path {...stroke} d="M3 10v4M7 7v10M11 4v16M15 7v10M19 10v4" />
    </Svg>
  );
}

export function IconCheck({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path {...stroke} d="M4.5 12.5 10 18 19.5 6.5" />
    </Svg>
  );
}

export function IconX({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path {...stroke} d="M6 6l12 12M18 6 6 18" />
    </Svg>
  );
}

export function IconBack({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path {...stroke} d="M15 5 8 12l7 7" />
    </Svg>
  );
}

export function IconDownload({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path {...stroke} d="M12 3v12" />
      <path {...stroke} d="M6 11l6 6 6-6" />
      <path {...stroke} d="M4 21h16" />
    </Svg>
  );
}

export function IconCopy({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <rect {...stroke} x="8.5" y="8.5" width="12" height="12" rx="2" />
      <path {...stroke} d="M15.5 5.5V5a2 2 0 0 0-2-2h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h.5" />
    </Svg>
  );
}

export function IconRepeat({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path {...stroke} d="M3.5 8a9 9 0 0 1 15-3.5L20 6" />
      <path {...stroke} d="M20.5 16a9 9 0 0 1-15 3.5L4 18" />
      <path {...stroke} d="M20 1.5V6h-4.5M4 22.5V18h4.5" />
    </Svg>
  );
}

export function IconShield({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path {...stroke} d="M12 3 5 6v5c0 4.5 2.9 7.8 7 9.7 4.1-1.9 7-5.2 7-9.7V6z" />
      <path {...stroke} d="M9 12l2.2 2.2L15.5 9.5" />
    </Svg>
  );
}

export function IconEar({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path {...stroke} d="M6.5 10a5.5 5.5 0 0 1 11 0c0 2.2-1.3 3.2-2.5 4.2-1 .9-2 1.7-2 3.6" />
      <path {...stroke} d="M12.6 18.7a1 1 0 1 1-1.2-1.6" />
    </Svg>
  );
}

export function IconScan({ className }: { className?: string }) {
  return (
    <Svg className={className}>
      <path {...stroke} d="M3.5 7.5A4 4 0 0 1 7.5 3.5M16.5 3.5a4 4 0 0 1 4 4M20.5 16.5a4 4 0 0 1-4 4M7.5 20.5a4 4 0 0 1-4-4" />
      <path {...stroke} d="M3.5 12h17" />
    </Svg>
  );
}