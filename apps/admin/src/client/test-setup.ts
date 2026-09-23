import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// React Testing Library only auto-cleans when Vitest globals are on, and they
// are not here. Without this the previous test's DOM is still mounted and every
// `getByRole` finds two of everything.
afterEach(cleanup);
