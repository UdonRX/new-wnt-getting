export const X_LIST_ID = '2087706843519111304';
export const X_RSSHUB_BASE_URL = 'https://diygod-x-7872.onbelmo.uk';
export const X_LIST_PATH = `/twitter/list/${X_LIST_ID}`;
export const X_RSS_URL = `${X_RSSHUB_BASE_URL}${X_LIST_PATH}`;
export const X_RSSHUB_HOSTNAME = new URL(X_RSSHUB_BASE_URL).hostname.toLowerCase();
export const X_FEED = Object.freeze({ name: 'X', id: X_LIST_ID, url: X_RSS_URL });
