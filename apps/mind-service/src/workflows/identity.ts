// =============================================================================
// MindOS - Identity Service (Create Identity)
// =============================================================================

import * as restate from "@restatedev/restate-sdk"
import type { CoreSelf, PolicyProfile } from "../types.js"
import { createIdentity } from "./mind.js"

interface CreateIdentityRequest {
  display_name: string
  core_self?: Partial<CoreSelf>
  policy_profile?: Partial<PolicyProfile>
}

interface CreateIdentityResponse {
  identity_id: string
}

export const identityService = restate.service({
  name: "identity",
  handlers: {
    create: async (
      ctx: restate.Context,
      params: CreateIdentityRequest
    ): Promise<CreateIdentityResponse> => {
      const identityId = await ctx.run("create-identity", () =>
        createIdentity({
          displayName: params.display_name,
          coreSelf: params.core_self,
          policyProfile: params.policy_profile,
        })
      )

      return { identity_id: identityId }
    },
  },
})
