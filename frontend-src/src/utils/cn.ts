import clsx, { type ClassValue } from "clsx";

// Plain re-export so every component imports the same name. The design system
// is class-based, not utility-based, so most usage is just stringing classes
// together with a couple of conditional ones.
export function cn(...inputs: ClassValue[]): string {
  return clsx(...inputs);
}
