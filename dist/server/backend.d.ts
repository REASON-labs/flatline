/** Which backend answered: its place in the list (0 first) and its kind. */
export interface Via<K extends string = string> {
    index: number;
    kind: K;
}
/** A backend that is down or overloaded: the next one may still answer. Any other 4xx is about the request itself. */
export declare function shouldMoveOn(status: number): boolean;
/** No trailing slash; "" when unset. */
export declare function baseOf(url: unknown): string;
export declare function bearer(apiKey: string | undefined): Record<string, string>;
/** One line, at most 200 characters, with the key (if it is somehow in there) taken out. */
export declare function safeText(text: unknown, apiKey: string | undefined): string;
/** The reason in an error body: ours ({ error: "…" }) or the OpenAI shape ({ error: { message } }). */
export declare function reasonIn(body: unknown): string;
/**
 * Why an OpenAI-style service said no, in words safe to log. A refused key (401, 403) never
 * quotes the service's answer: some services repeat part of the key in it.
 */
export declare function refusal(what: string, status: number, body: unknown, apiKey: string | undefined): string;
export declare function isTimeout(e: unknown): boolean;
/** Is an OpenAI-style service up, and does it take the key? GET {url}/models. */
export declare function openaiUp(doFetch: typeof fetch, base: string, apiKey: string | undefined): Promise<boolean>;
