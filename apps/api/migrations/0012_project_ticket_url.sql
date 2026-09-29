-- Where a project's notification links point: the project's own operator
-- console. NULL keeps the deployment's OPERATOR_TICKET_URL_TEMPLATE, so
-- existing projects are unchanged until they set one.
ALTER TABLE app_mail_settings ADD COLUMN ticket_url_template TEXT;
