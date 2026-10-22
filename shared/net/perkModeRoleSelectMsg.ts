import { v2, type Vec2 } from "../utils/v2.ts";
import type { AbstractMsg, BitStream } from "./net.ts";

export class PerkModeRoleSelectMsg implements AbstractMsg {
    role = "";
    /** Spec Ops airstrike / care package map target. */
    hasPos = false;
    pos: Vec2 = v2.create(0, 0);

    serialize(s: BitStream) {
        s.writeGameType(this.role);
        s.writeBoolean(this.hasPos);
        if (this.hasPos) {
            s.writeMapPos(this.pos);
        }
    }

    deserialize(s: BitStream) {
        this.role = s.readGameType();
        this.hasPos = s.readBoolean();
        if (this.hasPos) {
            this.pos = s.readMapPos();
        } else {
            this.pos = v2.create(0, 0);
        }
    }
}
