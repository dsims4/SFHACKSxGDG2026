// Read JSON API responses and surface server errors to the caller.
async function readAPIResponse(response, fallbackErrorMessage) {
    // This boolean says whether the response header identifies a JSON body.
    const responseIsJSON = response.headers
        .get("content-type")
        ?.includes("application/json");
    // This object is the parsed JSON body, or an empty object for a non-JSON response.
    const responseData = responseIsJSON
        ? await response.json()
        : {};

    if (!response.ok) {
        throw new Error(
            responseData.error || fallbackErrorMessage
        );
    }

    return responseData;
}
