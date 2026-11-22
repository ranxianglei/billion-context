import assert from "node:assert/strict";
import test from "node:test";
import { googleToCore, type GoogleRequestBody } from "acp-kernel/wire";
import { imagePlaceholders, imagePlaceholdersForSummary } from "../src/image-note.js";
import { countImagesInParsedBody, countImagesInRawBody, imageTokensInParsedBody, imageTokensInRawBody, pixelTileEstimate, REMOTE_IMAGE_TOKENS } from "../src/image-tokens.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const image = { inlineData: { mimeType: "image/png", data: png } };
const remote = { fileData: { mimeType: "image/jpeg", fileUri: "https://example.com/screenshot.jpg" } };
const toolBody: GoogleRequestBody = {
    contents: [{ role: "user", parts: [{ functionResponse: {
        name: "screenshot", response: { output: "Captured two views" }, parts: [image, image],
    } }] }],
};

test("Google tool-result image notes retain every image and its recovery ref", () => {
    const message = googleToCore(toolBody).msgs[0];
    assert.equal(message.text, "Captured two views");
    assert.deepEqual(imagePlaceholders(message), ["[image: png 1x1]", "[image: png 1x1]"]);
    assert.deepEqual(imagePlaceholdersForSummary(message, "m00002"), ["[image: png 1x1 · m00002]", "[image: png 1x1 · m00002]"]);
    assert.ok(!imagePlaceholdersForSummary(message, "m00002").join(" ").includes(png));
});

test("Google remote image notes are retained without fetching or exposing the URL", () => {
    const message = googleToCore({ contents: [{ role: "user", parts: [remote] }] }).msgs[0];
    assert.deepEqual(imagePlaceholders(message), ["[image: jpeg]"]);
});

test("Google nested image bytes and pixels are counted in both parsed and raw entry points", () => {
    const bytes = 2 * Math.ceil(png.length / 4);
    const pixels = 2 * pixelTileEstimate(1, 1);
    assert.equal(imageTokensInParsedBody("google", toolBody, "bytes"), bytes);
    assert.equal(imageTokensInRawBody("google", JSON.stringify(toolBody), "bytes"), bytes);
    assert.equal(imageTokensInParsedBody("google", toolBody, "pixels"), pixels);
    assert.equal(imageTokensInRawBody("google", JSON.stringify(toolBody), "pixels"), pixels);
    assert.equal(countImagesInParsedBody("google", toolBody), 2);
    assert.equal(countImagesInRawBody("google", JSON.stringify(toolBody)), 2);
    assert.equal(imageTokensInParsedBody("google", toolBody, "pixels", 100), 200);
});

test("Google tool images share top-level media billing without charging the result text twice", () => {
    const body: GoogleRequestBody = { contents: [{ role: "user", parts: [image, { functionResponse: {
        name: "screenshot", response: { output: "result text ".repeat(1000) }, parts: [remote, image],
    } }] }] };
    assert.equal(countImagesInParsedBody("google", body), 3);
    assert.equal(imageTokensInParsedBody("google", body, "pixels"), 2 * pixelTileEstimate(1, 1) + REMOTE_IMAGE_TOKENS);
    const textOnly: GoogleRequestBody = { contents: [{ role: "user", parts: [{ functionResponse: { name: "text", response: { output: "plain" } } }] }] };
    assert.equal(imageTokensInParsedBody("google", textOnly), 0);
    assert.equal(countImagesInParsedBody("google", textOnly), 0);
    assert.deepEqual(imagePlaceholders(googleToCore(textOnly).msgs[0]), []);
});

test("Google nested non-image media is billed and counted but earns no recovery note", () => {
    const data = "JVBERi0xLjQKJcOkw7zDtsOfCg==";
    const body: GoogleRequestBody = { contents: [{ role: "user", parts: [{ functionResponse: {
        name: "export_doc", response: { output: "written" }, parts: [{ inlineData: { mimeType: "application/pdf", data } }],
    } }] }] };
    assert.equal(countImagesInParsedBody("google", body), 1);
    assert.equal(imageTokensInParsedBody("google", body, "bytes"), Math.ceil(data.length / 4));
    // Negative direction of the image/* note gate (#3617): the note carries a
    // decompress({ imageRef }) recovery ref, and the restore channel indexes
    // NESTED google media only for image/* mimes (src/image-restore.ts) — an
    // note here would promise a restore it cannot deliver. Billing stays
    // mime-agnostic: every forwarded byte reaches upstream.
    assert.deepEqual(imagePlaceholders(googleToCore(body).msgs[0]), []);
});
