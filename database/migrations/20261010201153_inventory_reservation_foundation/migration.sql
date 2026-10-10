CREATE TYPE "inventory_movement_type" AS ENUM('RECEIPT', 'ADJUSTMENT', 'RESERVATION', 'RESERVATION_RELEASE');--> statement-breakpoint
CREATE TYPE "inventory_reservation_status" AS ENUM('ACTIVE', 'RELEASED');--> statement-breakpoint
CREATE TYPE "sale_lifecycle_status" AS ENUM('OPEN', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"catalog_item_id" uuid NOT NULL,
	"sale_id" uuid,
	"reservation_id" uuid,
	"movement_type" "inventory_movement_type" NOT NULL,
	"delta_on_hand" integer NOT NULL,
	"delta_reserved" integer NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_movements_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "inventory_movements_effect_matches_type" CHECK (("movement_type" = 'RECEIPT' AND "delta_on_hand" > 0 AND "delta_reserved" = 0 AND "sale_id" IS NULL AND "reservation_id" IS NULL) OR ("movement_type" = 'ADJUSTMENT' AND "delta_on_hand" <> 0 AND "delta_reserved" = 0 AND "sale_id" IS NULL AND "reservation_id" IS NULL) OR ("movement_type" = 'RESERVATION' AND "delta_on_hand" = 0 AND "delta_reserved" > 0 AND "sale_id" IS NOT NULL AND "reservation_id" IS NOT NULL) OR ("movement_type" = 'RESERVATION_RELEASE' AND "delta_on_hand" = 0 AND "delta_reserved" < 0 AND "sale_id" IS NOT NULL AND "reservation_id" IS NOT NULL)),
	CONSTRAINT "inventory_movements_idempotency_key_format" CHECK ("idempotency_key" ~ '^[!-~]{1,200}$')
);
--> statement-breakpoint
CREATE TABLE "inventory_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"catalog_item_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"status" "inventory_reservation_status" DEFAULT 'ACTIVE'::"inventory_reservation_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"released_by_user_id" uuid,
	CONSTRAINT "inventory_reservations_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "inventory_reservations_sale_item_unique" UNIQUE("organization_id","sale_id","catalog_item_id"),
	CONSTRAINT "inventory_reservations_quantity_positive" CHECK ("quantity" BETWEEN 1 AND 1000000),
	CONSTRAINT "inventory_reservations_release_state_consistent" CHECK (("status" = 'ACTIVE' AND "released_at" IS NULL AND "released_by_user_id" IS NULL) OR ("status" = 'RELEASED' AND "released_at" IS NOT NULL AND "released_by_user_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "inventory_stock_balances" (
	"organization_id" uuid,
	"branch_id" uuid,
	"catalog_item_id" uuid,
	"on_hand" integer DEFAULT 0 NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_stock_balances_pk" PRIMARY KEY("organization_id","branch_id","catalog_item_id"),
	CONSTRAINT "inventory_stock_on_hand_nonnegative" CHECK ("on_hand" >= 0),
	CONSTRAINT "inventory_stock_reserved_nonnegative" CHECK ("reserved" >= 0),
	CONSTRAINT "inventory_stock_reserved_within_on_hand" CHECK ("reserved" <= "on_hand")
);
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "cancelled_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "sales" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "sales" ALTER COLUMN "status" SET DATA TYPE "sale_lifecycle_status" USING "status"::text::"sale_lifecycle_status";--> statement-breakpoint
ALTER TABLE "sales" ALTER COLUMN "status" SET DEFAULT 'OPEN'::"sale_lifecycle_status";--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_movements_idempotency_unique" ON "inventory_movements" ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "inventory_movements_branch_created_idx" ON "inventory_movements" ("organization_id","branch_id","created_at");--> statement-breakpoint
CREATE INDEX "inventory_reservations_branch_status_idx" ON "inventory_reservations" ("organization_id","branch_id","status");--> statement-breakpoint
CREATE INDEX "inventory_stock_branch_item_idx" ON "inventory_stock_balances" ("organization_id","branch_id","catalog_item_id");--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_actor_user_id_users_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_stock_balance_fk" FOREIGN KEY ("organization_id","branch_id","catalog_item_id") REFERENCES "inventory_stock_balances"("organization_id","branch_id","catalog_item_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_sale_fk" FOREIGN KEY ("organization_id","sale_id") REFERENCES "sales"("organization_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_reservation_fk" FOREIGN KEY ("organization_id","reservation_id") REFERENCES "inventory_reservations"("organization_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_released_by_user_id_users_id_fkey" FOREIGN KEY ("released_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_sale_fk" FOREIGN KEY ("organization_id","sale_id") REFERENCES "sales"("organization_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_sale_line_fk" FOREIGN KEY ("organization_id","sale_id","catalog_item_id") REFERENCES "sale_lines"("organization_id","sale_id","catalog_item_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_stock_balance_fk" FOREIGN KEY ("organization_id","branch_id","catalog_item_id") REFERENCES "inventory_stock_balances"("organization_id","branch_id","catalog_item_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory_stock_balances" ADD CONSTRAINT "inventory_stock_balances_branch_fk" FOREIGN KEY ("organization_id","branch_id") REFERENCES "branches"("organization_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "inventory_stock_balances" ADD CONSTRAINT "inventory_stock_balances_catalog_item_fk" FOREIGN KEY ("organization_id","catalog_item_id") REFERENCES "catalog_items"("organization_id","id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_cancelled_by_user_id_users_id_fkey" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_cancellation_state_consistent" CHECK (("status" = 'OPEN' AND "cancelled_at" IS NULL AND "cancelled_by_user_id" IS NULL) OR ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL AND "cancelled_by_user_id" IS NOT NULL));--> statement-breakpoint
DROP TYPE "sale_status";
--> statement-breakpoint
INSERT INTO "permissions" ("key", "module_key", "resource_key", "action_key", "description", "status", "is_system")
VALUES
	('core.sales.sale.cancel', 'core.sales', 'sale', 'cancel', 'Cancel an unpaid sale and release its stock reservation.', 'ACTIVE', true),
	('core.inventory.stock.read', 'core.inventory', 'stock', 'read', 'Read current-branch stock balances.', 'ACTIVE', true),
	('core.inventory.stock.adjust', 'core.inventory', 'stock', 'adjust', 'Receive or adjust current-branch stock.', 'ACTIVE', true),
	('core.inventory.stock.reserve', 'core.inventory', 'stock', 'reserve', 'Reserve current-branch stock for an unpaid sale.', 'ACTIVE', true),
	('core.inventory.stock.release', 'core.inventory', 'stock', 'release', 'Release stock reservations when cancelling an unpaid sale.', 'ACTIVE', true)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "modules" ("key", "name", "description", "lifecycle", "is_available")
VALUES ('core.inventory', 'Inventory', 'Branch-local stock balances, movements, and reservations.', 'AVAILABLE', true)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "module_versions" ("module_id", "version", "status", "manifest")
SELECT "id", '1.1.0', 'AVAILABLE', jsonb_build_object(
	'name', 'core.sales',
	'version', '1.1.0',
	'displayName', 'Sales',
	'dependencies', '[]'::jsonb,
	'permissions', jsonb_build_array('core.sales.sale.create', 'core.sales.sale.read', 'core.sales.sale.cancel'),
	'features', '[]'::jsonb,
	'lifecycle', 'AVAILABLE'
)
FROM "modules"
WHERE "key" = 'core.sales'
ON CONFLICT ("module_id", "version") DO NOTHING;
--> statement-breakpoint
INSERT INTO "module_versions" ("module_id", "version", "status", "manifest")
SELECT "id", '1.0.0', 'AVAILABLE', jsonb_build_object(
	'name', 'core.inventory',
	'version', '1.0.0',
	'displayName', 'Inventory',
	'dependencies', jsonb_build_array(jsonb_build_object('moduleName', 'core.business_manager', 'minimumVersion', '1.0.0')),
	'permissions', jsonb_build_array('core.inventory.stock.read', 'core.inventory.stock.adjust', 'core.inventory.stock.reserve', 'core.inventory.stock.release'),
	'features', '[]'::jsonb,
	'lifecycle', 'AVAILABLE'
)
FROM "modules"
WHERE "key" = 'core.inventory'
ON CONFLICT ("module_id", "version") DO NOTHING;
--> statement-breakpoint
INSERT INTO "module_dependencies" ("module_id", "dependency_module_id", "minimum_version")
SELECT inventory."id", manager."id", '1.0.0'
FROM "modules" inventory
CROSS JOIN "modules" manager
WHERE inventory."key" = 'core.inventory'
	AND manager."key" = 'core.business_manager'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "module_permissions" ("module_id", "permission_id")
SELECT "modules"."id", "permissions"."id"
FROM "modules"
CROSS JOIN "permissions"
WHERE "modules"."key" IN ('core.sales', 'core.inventory')
	AND "permissions"."module_key" = "modules"."key"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE "inventory_stock_balances" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inventory_stock_balances" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "inventory_stock_balances_tenant_branch_isolation" ON "inventory_stock_balances"
USING (
	"organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid
	AND "branch_id" = nullif(current_setting('app.current_branch_id', true), '')::uuid
)
WITH CHECK (
	"organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid
	AND "branch_id" = nullif(current_setting('app.current_branch_id', true), '')::uuid
);
--> statement-breakpoint
ALTER TABLE "inventory_reservations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inventory_reservations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "inventory_reservations_tenant_branch_isolation" ON "inventory_reservations"
USING (
	"organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid
	AND "branch_id" = nullif(current_setting('app.current_branch_id', true), '')::uuid
)
WITH CHECK (
	"organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid
	AND "branch_id" = nullif(current_setting('app.current_branch_id', true), '')::uuid
);
--> statement-breakpoint
ALTER TABLE "inventory_movements" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inventory_movements" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "inventory_movements_tenant_branch_isolation" ON "inventory_movements"
USING (
	"organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid
	AND "branch_id" = nullif(current_setting('app.current_branch_id', true), '')::uuid
)
WITH CHECK (
	"organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid
	AND "branch_id" = nullif(current_setting('app.current_branch_id', true), '')::uuid
);
--> statement-breakpoint
CREATE FUNCTION apply_inventory_movement() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
	current_balance inventory_stock_balances%ROWTYPE;
BEGIN
	IF NEW.organization_id <> nullif(current_setting('app.current_organization_id', true), '')::uuid
		OR NEW.branch_id <> nullif(current_setting('app.current_branch_id', true), '')::uuid
		OR NEW.actor_user_id <> nullif(current_setting('app.current_user_id', true), '')::uuid THEN
		RAISE EXCEPTION 'Inventory movement context mismatch' USING ERRCODE = '42501';
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM catalog_items item
		WHERE item.organization_id = NEW.organization_id
			AND item.id = NEW.catalog_item_id
			AND item.type = 'PRODUCT'
			AND item.status = 'ACTIVE'
			AND (item.branch_id IS NULL OR item.branch_id = NEW.branch_id)
	) THEN
		RAISE EXCEPTION 'Inventory movement item unavailable' USING ERRCODE = '23514';
	END IF;

	SELECT * INTO current_balance
	FROM inventory_stock_balances
	WHERE organization_id = NEW.organization_id
		AND branch_id = NEW.branch_id
		AND catalog_item_id = NEW.catalog_item_id
	FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'Branch stock balance is not initialized' USING ERRCODE = '23503';
	END IF;

	IF NEW.movement_type IN ('RESERVATION', 'RESERVATION_RELEASE') THEN
		IF NEW.movement_type = 'RESERVATION' THEN
			IF NEW.idempotency_key <> 'reservation:' || NEW.reservation_id::text || ':reserve'
				OR NOT EXISTS (
					SELECT 1 FROM inventory_reservations r
					JOIN sales s ON s.organization_id = r.organization_id AND s.id = r.sale_id
					WHERE r.organization_id = NEW.organization_id
						AND r.id = NEW.reservation_id
						AND r.sale_id = NEW.sale_id
						AND r.branch_id = NEW.branch_id
						AND r.catalog_item_id = NEW.catalog_item_id
						AND r.status = 'ACTIVE'
						AND r.quantity = NEW.delta_reserved
						AND s.status = 'OPEN'
				) THEN
				RAISE EXCEPTION 'Reservation movement does not match active reservation' USING ERRCODE = '23514';
			END IF;
		ELSE
			IF NEW.idempotency_key <> 'reservation:' || NEW.reservation_id::text || ':release'
				OR NOT EXISTS (
					SELECT 1 FROM inventory_reservations r
				JOIN sales s ON s.organization_id = r.organization_id AND s.id = r.sale_id
				WHERE r.organization_id = NEW.organization_id
					AND r.id = NEW.reservation_id
					AND r.sale_id = NEW.sale_id
					AND r.branch_id = NEW.branch_id
					AND r.catalog_item_id = NEW.catalog_item_id
					AND r.status = 'RELEASED'
					AND r.quantity = -NEW.delta_reserved
				) THEN
				RAISE EXCEPTION 'Release movement does not match cancelled sale reservation' USING ERRCODE = '23514';
			END IF;
		END IF;
	END IF;

	UPDATE inventory_stock_balances
	SET on_hand = on_hand + NEW.delta_on_hand,
		reserved = reserved + NEW.delta_reserved,
		updated_at = now()
	WHERE organization_id = NEW.organization_id
		AND branch_id = NEW.branch_id
		AND catalog_item_id = NEW.catalog_item_id
		AND on_hand + NEW.delta_on_hand >= 0
		AND reserved + NEW.delta_reserved >= 0
		AND reserved + NEW.delta_reserved <= on_hand + NEW.delta_on_hand;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INSUFFICIENT_AVAILABLE_STOCK';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION apply_inventory_movement() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER inventory_movements_apply_balance
AFTER INSERT ON "inventory_movements"
FOR EACH ROW EXECUTE FUNCTION apply_inventory_movement();
--> statement-breakpoint
CREATE FUNCTION create_reservation_movement() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
	INSERT INTO inventory_movements (
		organization_id, branch_id, catalog_item_id, sale_id, reservation_id,
		movement_type, delta_on_hand, delta_reserved, idempotency_key,
		request_hash, actor_user_id
	) VALUES (
		NEW.organization_id, NEW.branch_id, NEW.catalog_item_id, NEW.sale_id, NEW.id,
		'RESERVATION', 0, NEW.quantity, 'reservation:' || NEW.id::text || ':reserve',
		repeat('0', 64), nullif(current_setting('app.current_user_id', true), '')::uuid
	);
	RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION create_reservation_movement() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER inventory_reservation_created_movement
AFTER INSERT ON "inventory_reservations"
FOR EACH ROW EXECUTE FUNCTION create_reservation_movement();
--> statement-breakpoint
CREATE FUNCTION guard_reservation_release() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF OLD.status <> 'ACTIVE' OR NEW.status <> 'RELEASED'
		OR NEW.organization_id <> OLD.organization_id
		OR NEW.branch_id <> OLD.branch_id
		OR NEW.sale_id <> OLD.sale_id
		OR NEW.catalog_item_id <> OLD.catalog_item_id
		OR NEW.quantity <> OLD.quantity
		OR NEW.released_by_user_id <> nullif(current_setting('app.current_user_id', true), '')::uuid
		THEN
		RAISE EXCEPTION 'Reservation release transition is not allowed' USING ERRCODE = '55000';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER inventory_reservation_release_guard
BEFORE UPDATE ON "inventory_reservations"
FOR EACH ROW EXECUTE FUNCTION guard_reservation_release();
--> statement-breakpoint
CREATE FUNCTION record_reservation_release_movement() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
	INSERT INTO inventory_movements (
		organization_id, branch_id, catalog_item_id, sale_id, reservation_id,
		movement_type, delta_on_hand, delta_reserved, idempotency_key,
		request_hash, actor_user_id
	) VALUES (
		NEW.organization_id, NEW.branch_id, NEW.catalog_item_id, NEW.sale_id, NEW.id,
		'RESERVATION_RELEASE', 0, -NEW.quantity, 'reservation:' || NEW.id::text || ':release',
		repeat('0', 64), NEW.released_by_user_id
	);
	RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION record_reservation_release_movement() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER inventory_reservation_release_movement
AFTER UPDATE ON "inventory_reservations"
FOR EACH ROW WHEN (OLD.status = 'ACTIVE' AND NEW.status = 'RELEASED')
EXECUTE FUNCTION record_reservation_release_movement();
--> statement-breakpoint
CREATE FUNCTION guard_sale_transition() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF OLD.status <> 'OPEN' OR NEW.status <> 'CANCELLED'
		OR to_jsonb(NEW) - ARRAY['status', 'cancelled_at', 'cancelled_by_user_id']
			<> to_jsonb(OLD) - ARRAY['status', 'cancelled_at', 'cancelled_by_user_id']
		OR NEW.cancelled_at IS NULL
		OR NEW.cancelled_by_user_id <> nullif(current_setting('app.current_user_id', true), '')::uuid
		OR NEW.organization_id <> nullif(current_setting('app.current_organization_id', true), '')::uuid
		OR NEW.branch_id <> nullif(current_setting('app.current_branch_id', true), '')::uuid THEN
		RAISE EXCEPTION 'Sale transition is not allowed' USING ERRCODE = '55000';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER "sales_immutable" ON "sales";
--> statement-breakpoint
CREATE TRIGGER sales_transition_guard
BEFORE UPDATE ON "sales"
FOR EACH ROW EXECUTE FUNCTION guard_sale_transition();
--> statement-breakpoint
CREATE TRIGGER sales_delete_guard
BEFORE DELETE ON "sales"
FOR EACH ROW EXECUTE FUNCTION reject_sale_mutation();
--> statement-breakpoint
CREATE FUNCTION verify_cancelled_sale_reservations() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_TABLE_NAME = 'sales' THEN
		IF NEW.status = 'CANCELLED' AND EXISTS (
			SELECT 1 FROM inventory_reservations r
			WHERE r.organization_id = NEW.organization_id
				AND r.sale_id = NEW.id
				AND r.status = 'ACTIVE'
		) THEN
			RAISE EXCEPTION 'Cancelled sale retains active inventory reservations' USING ERRCODE = '23514';
		END IF;
	ELSIF NEW.status = 'RELEASED' AND NOT EXISTS (
		SELECT 1 FROM sales s
		WHERE s.organization_id = NEW.organization_id
			AND s.id = NEW.sale_id
			AND s.status = 'CANCELLED'
	) THEN
		RAISE EXCEPTION 'Released reservation requires a cancelled sale' USING ERRCODE = '23514';
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sales_cancelled_reservations_consistent
AFTER UPDATE ON "sales"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION verify_cancelled_sale_reservations();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER inventory_released_reservation_sale_consistent
AFTER UPDATE ON "inventory_reservations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION verify_cancelled_sale_reservations();
--> statement-breakpoint
ALTER TABLE "sales" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "sales" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "sale_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "sale_lines" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inventory_stock_balances" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inventory_stock_balances" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inventory_reservations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inventory_reservations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inventory_movements" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inventory_movements" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION reject_inventory_movement_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'Inventory movement ledger is append-only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER inventory_movements_immutable
BEFORE UPDATE OR DELETE ON "inventory_movements"
FOR EACH ROW EXECUTE FUNCTION reject_inventory_movement_mutation();
--> statement-breakpoint
CREATE TRIGGER inventory_stock_balance_zero_insert
BEFORE INSERT ON "inventory_stock_balances"
FOR EACH ROW WHEN (NEW.on_hand <> 0 OR NEW.reserved <> 0)
EXECUTE FUNCTION reject_inventory_movement_mutation();
--> statement-breakpoint
GRANT SELECT ON "inventory_stock_balances", "inventory_reservations", "inventory_movements" TO onecore_app;
--> statement-breakpoint
GRANT INSERT ("organization_id", "branch_id", "catalog_item_id") ON "inventory_stock_balances" TO onecore_app;
--> statement-breakpoint
GRANT INSERT ("id", "organization_id", "branch_id", "sale_id", "catalog_item_id", "quantity", "created_at") ON "inventory_reservations" TO onecore_app;
--> statement-breakpoint
GRANT UPDATE ("status", "released_at", "released_by_user_id") ON "inventory_reservations" TO onecore_app;
GRANT UPDATE ("status", "cancelled_at", "cancelled_by_user_id") ON "sales" TO onecore_app;
--> statement-breakpoint
GRANT INSERT ("cancelled_at", "cancelled_by_user_id") ON "sales" TO onecore_app;