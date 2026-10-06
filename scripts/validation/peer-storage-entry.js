import * as storage from '../../src/teamMessaging/store.ts';
import * as crypto from '../../src/teamMessaging/crypto.ts';
window.peerTest={...storage,...crypto};
import {PeerClient} from '../../src/teamMessaging/client.ts';
window.peerTest.PeerClient=PeerClient;
import * as history from '../../src/teamMessaging/history.ts';
Object.assign(window.peerTest,history);
