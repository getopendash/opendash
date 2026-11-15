-- An insight is dismissed only by a person. The Investigator's verdict (a model's, which reads the
-- organization's data and text) never closes one, so 0049's not_confirmed reason goes again.
ALTER TABLE "app"."insight" DROP CONSTRAINT "insight_dismiss_check";--> statement-breakpoint
ALTER TABLE "app"."insight" ADD CONSTRAINT "insight_dismiss_check" CHECK ("app"."insight"."dismiss_reason" is null or "app"."insight"."dismiss_reason" in ('not_a_problem', 'known_issue', 'wrong_data', 'not_my_area'));