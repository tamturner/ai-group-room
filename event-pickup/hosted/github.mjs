import { createRemoteJWKSet, jwtVerify } from "jose";

export const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
const keys = createRemoteJWKSet(new URL(GITHUB_ISSUER + "/.well-known/jwks"), {
  timeoutDuration: 5000
});
const workflowPath = ".github/workflows/group-room-pickup-pilot.yml";
const turnFile = /^inbox\/turns\/turn-[0-9]+-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.json$/;

export async function verifyGitHubPush(request, env, jwks = keys) {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;

  const ref = "refs/heads/" + env.ROOM_BRANCH;
  let claims;
  try {
    ({ payload: claims } = await jwtVerify(authorization.slice(7), jwks, {
      issuer: GITHUB_ISSUER,
      audience: env.ROOM_ORIGIN + "/github",
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "sub"],
      maxTokenAge: "10 min"
    }));
  } catch {
    return null;
  }
  if (claims.repository !== env.ROOM_REPOSITORY || claims.repository_id !== env.ROOM_REPOSITORY_ID ||
      claims.ref !== ref || claims.event_name !== "push" || claims.runner_environment !== "github-hosted" ||
      claims.workflow_ref !== env.ROOM_REPOSITORY + "/" + workflowPath + "@" + ref) return null;

  const body = await request.json();
  if (body?.sha !== claims.sha || !/^[a-f0-9]{40}$/.test(body.sha) ||
      !Array.isArray(body.files) || body.files.length > 25 ||
      !body.files.every(path => typeof path === "string" && turnFile.test(path))) {
    throw new Error("Invalid GitHub turn signal.");
  }
  return { repository: { full_name: env.ROOM_REPOSITORY }, ref, commits: [{ added: body.files }] };
}
