// The audio worker's entry. Bundled by `vite-plugin-worklet` (`?worklet`), the way `@moq/publish` builds
// its capture worker, and loaded only by a page that hands its audio to it. See `host.ts` for what it
// runs and `protocol.ts` for what it says.

import { type Port, serve } from "./host";

serve(self as unknown as Port);
