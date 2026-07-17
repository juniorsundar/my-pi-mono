/**
 * Gate spike for the web-search TS port (#0011).
 *
 * Confirms @mozilla/readability + linkedom interoperate at runtime under the
 * root Node/jiti/vitest setup: linkedom parses HTML into a Document, Readability
 * extracts readable {title, content, textContent} from it. This is the
 * highest-risk item flagged in #0008 and the named gate for the port in #0009.
 *
 * Not a behaviour port of `representation` — only a runtime-interop proof.
 */
import { describe, it, expect } from "vitest";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

describe("readability + linkedom spike (#0011)", () => {
	it("extracts readable title/content/textContent from a linkedom document", () => {
		const html = `<!doctype html><html><head><title>A Nice Page</title></head>
<body>
  <nav>menu junk</nav>
  <article>
    <h1>Real Article</h1>
    <p>This is the readable body content that should survive extraction.</p>
    <p>A second paragraph with enough text to be considered readerable.</p>
  </article>
  <footer>footer junk</footer>
</body></html>`;

		const { document } = parseHTML(html);
		const article = new Readability(document).parse();

		expect(article, "Readability.parse() returned null").not.toBeNull();
		// Readability prefers the <title> tag for `.title`; just assert it's non-empty + sensible.
		expect(article!.title, "title extracted").toMatch(/A Nice Page|Real Article/);
		expect(article!.content, "content (html) non-empty").toMatch(/<p>/);
		expect(article!.textContent, "textContent non-empty").toContain(
			"readable body content",
		);
		expect(article!.length, "length is a positive number").toBeGreaterThan(0);
	});
});