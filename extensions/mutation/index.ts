import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerBashApproval from "./bash-approval.js";
import registerDiffApproval from "./diff-approval.js";
import registerPermissionProfile from "./permission-profile.js";

/**
 * Mutation Package — canonical owner of mutation-related approval behavior.
 *
 * Registers permission profile state/commands, Bash Approval, and
 * edit/write diff approval.
 */
export default function registerMutationPackage(pi: ExtensionAPI) {
  registerPermissionProfile(pi);
  registerDiffApproval(pi);
  registerBashApproval(pi);
}
