-- Whether a project's new inquiries get an automatic receipt, and which of its
-- templates writes it. Project data, like the other mail settings, rather than
-- part of a mail credential route: a project that sends from the deployment's
-- own provider can still choose. NULL keeps the current behaviour (the route's
-- `inquiryReceipt` / `inquiryReceiptTemplate`, else on with the conventional
-- template keys), so existing projects are unchanged until they set it.
ALTER TABLE app_mail_settings ADD COLUMN inquiry_receipt INTEGER CHECK (inquiry_receipt IN (0, 1));
ALTER TABLE app_mail_settings ADD COLUMN inquiry_receipt_template TEXT;
