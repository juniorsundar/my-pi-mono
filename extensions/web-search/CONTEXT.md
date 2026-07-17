# Web Search and Fetch

This context covers finding public web resources and turning a selected resource into content an agent can inspect safely.

## Language

**Fetched document**:
A public web resource together with its source metadata and the representation produced for agent consumption.

**Content preview**:
The bounded portion of the available representation of a **Fetched document** returned directly in a tool result. Preview truncation is recoverable through a **Content artifact**.
_Avoid_: Full content

**Content artifact**:
The complete available representation of a **Fetched document** made available outside the bounded **Content preview**. It has the same representation as the preview and cannot restore source content that was never obtained.
_Avoid_: Raw download, remainder

**Source truncation**:
A condition where a transport or upstream service limit prevents the fetched representation itself from being complete. It is distinct from recoverable preview truncation.
_Avoid_: Preview truncation

**Readable representation**:
A Markdown or plain-text representation of a **Fetched document** with page chrome and non-content markup removed.
_Avoid_: Raw content

**Raw source**:
The decoded response body of a **Fetched document**, before readability extraction or Markdown conversion. Raw source still uses a bounded **Content preview** and a **Content artifact** when its preview is truncated.
_Avoid_: Download

**GitHub resource**:
A repository root, directory tree, or blob file identified by a recognized `github.com` repository, `/tree/`, or `/blob/` URL. A recognized GitHub resource is resolved through GitHub's API rather than interpreted as an ordinary web page.
_Avoid_: GitHub page

**GitHub resolution failure**:
An explicit, immediate failure to resolve a recognized **GitHub resource**, including missing, unauthorized, rate-limited, and oversized resources. It must not silently become an ordinary HTML fetch.
_Avoid_: Empty document

**Partial tree**:
A deterministic, bounded representation of a GitHub repository or directory whose full descendant set was not obtained. A partial tree is marked with **Source truncation** and must not be described as complete.
_Avoid_: Repository tree

## Example dialogue

> **Developer:** The content preview was truncated. Did we preserve the fetched document?
>
> **Domain expert:** Yes. The preview is bounded, and its content artifact contains the complete available representation.
>
> **Developer:** Does that artifact contain the original HTML response?
>
> **Domain expert:** No. It matches the extracted representation used by the preview; raw source is a separate concern.
