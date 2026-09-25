// The audio worker's entry. Compiled and inlined as a blob URL by Vite (`?worker&inline`), the way
// `@moq/publish` builds its capture worker, and loaded only by a page that hands its audio to it. See
// `host.ts` for what it runs and `protocol.ts` for what it says.

import { type Port, serve } from "./host";

serve(self as unknown as Port);
