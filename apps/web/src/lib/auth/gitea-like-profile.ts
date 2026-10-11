import { z } from 'zod';

// Gitea and Forgejo return the identical `/api/v1/user` shape. Optional fields are
// read permissively — a blank name or avatar is common — so a schema failure here
// means the payload is genuinely from another platform, not merely sparse.
const giteaLikeProfileSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().trim().min(1),
  email: z.string().email().nullish(),
  name: z.string().nullish(),
  avatar_url: z.string().nullish(),
});

/**
 * Maps a Gitea/Forgejo `/api/v1/user` response to a NextAuth user. Both platforms
 * return the same shape, so one parser serves both. A missing email is refused
 * rather than coerced: sign-in settlement needs an address, and Gitea only
 * returns one when the OAuth grant carries the `read:user` scope.
 */
export function parseGiteaLikeProfile(profile: unknown) {
  const parsed = giteaLikeProfileSchema.parse(profile);
  if (!parsed.email) {
    throw new Error('Gitea provider did not return an email address');
  }
  const displayName = parsed.name?.trim();
  const avatarUrl = parsed.avatar_url?.trim();
  return {
    id: String(parsed.id),
    email: parsed.email,
    name: displayName || parsed.login,
    image: avatarUrl ? avatarUrl : null,
  };
}
