import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { HermesIcon } from "../Icons";
import { PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";

describe("PROVIDER_ICON_BY_PROVIDER", () => {
  it("keeps the Hermes driver mapped to the official Hermes icon", () => {
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("hermes")]).toBe(HermesIcon);
  });
});
