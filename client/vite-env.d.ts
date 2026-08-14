/// <reference types="vite/client" />

type ClientConfiguration = {
	serverBaseUrl: string;
	authentication:
		| { type: "none" }
		| { type: "bearer"; token: string }
		| { type: "cookie" };
};

declare global {
	interface Window {
		VIDEOCUTLIST_CONFIG?: ClientConfiguration;
	}
}
