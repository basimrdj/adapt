import { PageFilterBundle } from './types';

export function matchesDomain(hostname: string, domains: string[], excludedDomains: string[]): boolean {
  const host = hostname.toLowerCase();
  const excluded = excludedDomains.some((domain) => host === domain || host.endsWith(`.${domain.replace(/^\*\./, '')}`));
  if (excluded) return false;
  if (domains.length === 0) return true;
  return domains.some((domain) => {
    const normalized = domain.replace(/^\*\./, '');
    return normalized === '*' || host === normalized || host.endsWith(`.${normalized}`);
  });
}

export function exceptionMatches(
  hostname: string,
  selector: string,
  exceptions: PageFilterBundle['exceptions']
): boolean {
  return exceptions.some((exception) =>
    !exception.scriptletName &&
    exception.selector === selector &&
    matchesDomain(hostname, exception.domains, exception.excludedDomains)
  );
}

export function scriptletExceptionMatches(
  hostname: string,
  name: string,
  args: string[],
  exceptions: PageFilterBundle['exceptions']
): boolean {
  return exceptions.some((exception) =>
    exception.scriptletName === name &&
    JSON.stringify(exception.scriptletArgs || []) === JSON.stringify(args) &&
    matchesDomain(hostname, exception.domains, exception.excludedDomains)
  );
}
