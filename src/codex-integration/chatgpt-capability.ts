/** ChatGPT subscription/Desktop is intentionally not treated as an API route.
 * This capability record is declarative: it never reads, copies, persists, or
 * injects auth.json, cookies, session tokens, or desktop credentials. */
export interface ChatGptDesktopCapability {
    state: "待完成/可实现";
    credentials: "not-read-not-persisted";
    officialLoginChannels: "preserved";
    desktopMcp: "separate-from-model-routing";
}

export const chatGptDesktopCapability: ChatGptDesktopCapability = {
    state: "待完成/可实现",
    credentials: "not-read-not-persisted",
    officialLoginChannels: "preserved",
    desktopMcp: "separate-from-model-routing",
};
