const LINK_FACET = 'app.bsky.richtext.facet#link';
const EXTERNAL_EMBED = 'app.bsky.embed.external';
const RECORD_WITH_MEDIA_EMBED = 'app.bsky.embed.recordWithMedia';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null;
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A scheme, as opposed to the `host:port` of a scheme-less URL. */
const SCHEME = /^[a-z][a-z\d+.-]*:(?!\d)/i;

const WEB_PROTOCOLS = ['http:', 'https:'];

/** Hostname of a web link; undefined for anything else (at://, mailto:, garbage). */
function hostnameOf(url: string): string | undefined {
  try {
    const { protocol, hostname } = new URL(SCHEME.test(url) ? url : `https://${url}`);
    if (!WEB_PROTOCOLS.includes(protocol)) return undefined;
    return hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return undefined;
  }
}

/** True when the URL's host is one of `domains` or a subdomain of one. */
export function urlMatchesDomain(url: unknown, domains: readonly string[]): boolean {
  if (typeof url !== 'string') return false;
  const host = hostnameOf(url);
  if (!host) return false;
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function externalEmbedUri(embed: unknown): unknown {
  if (!isObj(embed)) return undefined;
  if (embed.$type === RECORD_WITH_MEDIA_EMBED) return externalEmbedUri(embed.media);
  if (embed.$type !== EXTERNAL_EMBED || !isObj(embed.external)) return undefined;
  return embed.external.uri;
}

/** Every link a post record carries: rich-text facets, link-card embed, legacy entities. */
export function postLinks(post: unknown): unknown[] {
  if (!isObj(post)) return [];

  const facetLinks = asArray(post.facets)
    .flatMap((facet) => (isObj(facet) ? asArray(facet.features) : []))
    .filter(isObj)
    .filter((feature) => feature.$type === LINK_FACET)
    .map((feature) => feature.uri);

  const entityLinks = asArray(post.entities)
    .filter(isObj)
    .filter((entity) => entity.type === 'link')
    .map((entity) => entity.value);

  return [...facetLinks, externalEmbedUri(post.embed), ...entityLinks];
}

export function postMatches(post: unknown, domains: readonly string[]): boolean {
  return postLinks(post).some((link) => urlMatchesDomain(link, domains));
}
