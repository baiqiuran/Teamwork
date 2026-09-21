import type { ReactNode } from "react";

const paths = {
  diary: (
    <>
      <rect x="2.5" y="2" width="11" height="12" rx="2" />
      <path d="M5.5 5.5h5M5.5 8.5h5M5.5 11.5h3" />
    </>
  ),
  team: (
    <>
      <circle cx="5.75" cy="5.5" r="2.25" />
      <path d="M2.5 13.25c0-1.9 1.45-3.15 3.25-3.15s3.25 1.25 3.25 3.15" />
      <path d="M10.5 4a2.25 2.25 0 010 4.4M11.75 10.5c1.2.4 2 1.4 2 2.75" />
    </>
  ),
  workspace: (
    <>
      <rect x="2.5" y="2.5" width="5" height="5" rx="1.25" />
      <rect x="8.5" y="2.5" width="5" height="5" rx="1.25" />
      <rect x="2.5" y="8.5" width="5" height="5" rx="1.25" />
      <rect x="8.5" y="8.5" width="5" height="5" rx="1.25" />
    </>
  ),
  tasks: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M5.5 8l1.9 1.9L10.75 6" />
    </>
  ),
  share: (
    <>
      <path d="M6.75 9.25l2.5-2.5" />
      <path d="M5.5 8.25l-1.4 1.4a2.4 2.4 0 003.4 3.4l1.4-1.4" />
      <path d="M10.5 7.75l1.4-1.4a2.4 2.4 0 00-3.4-3.4l-1.4 1.4" />
    </>
  ),
  invite: (
    <>
      <circle cx="6" cy="5.25" r="2.25" />
      <path d="M2.5 13.25c0-1.9 1.55-3.25 3.5-3.25.9 0 1.7.3 2.3.8" />
      <path d="M10.75 11h3.5M12.5 9.25v3.5" />
    </>
  ),
  account: (
    <>
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3.5 13.5c0-2.5 2-4.25 4.5-4.25s4.5 1.75 4.5 4.25" />
    </>
  ),
  ai: (
    <>
      <rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1.75" />
      <path d="M6.5 1.75v2.5M9.5 1.75v2.5M6.5 11.75v2.5M9.5 11.75v2.5M1.75 6.5h2.5M1.75 9.5h2.5M11.75 6.5h2.5M11.75 9.5h2.5" />
    </>
  ),
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.75" />
      <path d="M5.75 7V5.4a2.25 2.25 0 014.5 0V7" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
