---
title: "vCenter \"User name and password are required\": Causes and Fixes"
date: 2026-11-10T09:00:00-06:00
draft: false
tags: ["VMware", "vCenter", "vSphere", "Troubleshooting", "Authentication", "Certificates"]
categories:
- VMware
- Troubleshooting
author: "Matthew Mattox - mmattox@support.tools"
description: "Why the vCenter login page says \"User name and password are required\" even with the right password: an expired STS signing certificate, a broken smart card setup, an SSO policy changed by STIG hardening, or stale browser state, and how to fix each."
more_link: "yes"
url: "/vcenter-user-name-and-password-are-required/"
quick_fix: "On vCenter 7.x, 8.x or 9.x, check the STS signing certificate first: run vCert (Broadcom KB 385107), menu 2, option 8. If it has expired, replace it with menu 3, option 8, after taking a snapshot of every vCenter in the SSO domain."
---

You type the correct password for `administrator@vsphere.local`, click **Login**, and the vSphere Client answers **"User name and password are required"** (often searched as "username and password are required"). The message is misleading. vCenter received both fields. It shows this text when vCenter Single Sign-On (SSO) cannot finish the login, and the most common reason is an expired Security Token Service (STS) signing certificate.

Short answer: check the STS signing certificate before anything else. If you use smart cards, check the smart card trust chain and port 3128. If the appliance was recently STIG hardened, check the SSO authentication policy. If only one browser fails, clear its cookies.

<!--more-->

## Where the Message Appears

The exact string comes from vCenter Single Sign-On: the vSphere Client's SSO login page (`/websso/`) shows it, and VAMI (port 5480) and SSH logins as SSO users fail the same way because they request a token from the same STS. Broadcom documents it in these contexts:

| Context | What you see | Most likely cause |
|---|---|---|
| vSphere Client, password login | "User name and password are required" for every account | Expired or duplicate STS signing certificate |
| VAMI (`https://vcenter:5480`) or SSH as an SSO user | "User name and password are required" or "unable to authenticate user" | Expired or duplicate STS signing certificate |
| vSphere Client, smart card login | The message right after choosing a certificate | Incomplete `clienttrustCA.pem`, wrong certificate on port 3128, or Firefox CORS handling |
| vSphere Client after STIG hardening | The message for SSO accounts, a "no permission" message for LDAP accounts | SSO authentication policy disabled password login |
| One browser only | The message after a snapshot revert or certificate change | Stale cookies or session state |

PowerCLI and the REST API do not print this string. When `Connect-VIServer` or `POST /api/session` fails at the same time as the web login, the cause is shared: both ask the same STS for a token. Fix the STS and they recover together.

## Confirm the Failure From the Command Line

Separate a browser problem from a server problem before changing anything. Test SSO without a browser:

```bash
# vSphere 7.0 U2 and later. A session ID in the response means SSO works.
curl -k -X POST -u 'administrator@vsphere.local' https://vcenter.example.com/api/session
```

```powershell
# PowerCLI, same check from Windows or PowerShell 7
Connect-VIServer -Server vcenter.example.com -Credential (Get-Credential)
```

If both succeed, the server is fine and the problem is the browser. Skip to the last cause. If both fail, look at the server.

On the appliance, SSH in as `root`, type `shell` at the `Command>` prompt, and check the SSO log for the STS error:

```bash
grep -i "Signing certificate is not valid" /var/log/vmware/sso/websso.log | tail -5
grep -iE "Could not parse HOK Token|certificates cannot be verified" /var/log/vmware/applmgmt/applmgmt.log | tail -5
```

A match in `websso.log` confirms the most common cause below.

## Cause 1: Expired or Duplicate STS Signing Certificate

The STS signing certificate signs every SSO token. When it expires, no user can get a token, and every login form reports "User name and password are required". Broadcom [KB 316619](https://knowledge.broadcom.com/external/article?legacyId=76719) lists the related symptoms you may also see:

- "Cannot connect to vCenter Single Sign-On server https://VC_FQDN/sts/STSService/vsphere.local"
- "HTTP Status 400 Bad Request Message BadRequest, Signing certificate is not valid"
- "No Healthy Upstream" or "503 Service Unavailable"
- `InvalidTimeRange` errors in the logs

[KB 377558](https://knowledge.broadcom.com/external/article/377558/error-unable-to-authenticate-user.html) covers the same cause for VAMI and SSH logins, and adds that a store holding **more than one** STS certificate breaks token issuance too.

This failure tends to arrive without warning. KB 316619 says the STS certificate generally expires two years after it was created (the exact timing depends on how the environment's certificates were set up), so an appliance that has been running for a while can hit it on an ordinary day. Do not wait for vCenter to tell you; check the dates yourself.

### Fix with vCert

Broadcom now directs all STS work to vCert, the scripted certificate replacement tool in [KB 385107](https://knowledge.broadcom.com/external/article/385107). It supports vCenter 7.x, 8.x and 9.x. The older `checksts.py` and `fixsts.sh` scripts from KB 79248 and KB 76719 are superseded; use vCert unless you are on 6.x.

1. Take snapshots first. For a standalone vCenter, a snapshot without memory. For Enhanced Linked Mode, power off **every** vCenter in the SSO domain and snapshot them all, so you can restore them to the same point.
2. Download the vCert zip from the KB attachments, copy it to `/root` on the appliance, and run it. The version in the file name changes; this example uses the release attached when this post was written:

```bash
cd /root
python -m zipfile -e vCert-6.1.2-20260713.zip .
cd vCert-6.1.2-20260713
chmod +x vCert.py
./vCert.py
```

3. Check the certificate: menu **2 (View Certificate Info)**, option **8 (STS signing certificates)**. Look at the validity dates and how many certificates are listed.
4. Replace it: menu **3 (Manage Certificates)**, option **8 (STS signing certificates)**. vCert prompts for the SSO administrator password.
5. Restart services if vCert does not do it for you (menu 8, or by hand):

```bash
service-control --stop --all && service-control --start --all
```

If services still fail to start, other certificates may have expired at the same time. List every VECS store with its expiry dates:

```bash
for i in $(/usr/lib/vmware-vmafd/bin/vecs-cli store list); do
  echo "STORE $i"
  /usr/lib/vmware-vmafd/bin/vecs-cli entry list --store "$i" --text | grep -E "Alias|Not After"
done
```

vCert menu 1 (Check current certificate status) reports the same data, and menu 3 replaces the Machine SSL, solution user and other certificates in the same session.

## Cause 2: Smart Card Login Problems

With smart card (CAC/PIV) authentication enabled, the browser sends the user certificate to the STS on **port 3128**, not 443. Three documented faults produce the same message.

**Incomplete trust chain.** [KB 405165](https://knowledge.broadcom.com/external/article/405165/unable-to-authenticate-with-smart-card-a.html): uploading the root and intermediate CAs to **Trusted Certificates** in the vSphere Client is not enough. The file `/usr/lib/vmware-sso/vmware-sts/conf/clienttrustCA.pem` must hold every certificate in the smart card certificate's chain. Export the chain from a user card and rebuild the file with the Broadcom TechDocs procedure "Configure the Reverse Proxy to Request Client Certificates".

**Port 3128 serves the wrong certificate.** [KB 373735](https://knowledge.broadcom.com/external/article/373735/smartcard-authentication-in-vcenter-fail.html) (vCenter 7.x and 8.x): the browser console shows `net::ERR_CERT_AUTHORITY_INVALID` on a POST to `https://VCENTER_FQDN:3128/websso/SAML2/SSOCAC/...`. Compare the two ports:

```bash
openssl s_client -connect vcenter.example.com:3128 </dev/null 2>/dev/null | openssl x509 -noout -subject -enddate
openssl s_client -connect vcenter.example.com:443  </dev/null 2>/dev/null | openssl x509 -noout -subject -enddate
grep Keystore /usr/lib/vmware-sso/vmware-sts/conf/server.xml
```

If the certificates differ and `server.xml` points at `STS_INTERNAL_SSL_CERT`, the fix is the `Delete_STS_INTERNAL_SSL_CERT.sh` script attached to that KB. Snapshot first: a regular snapshot for a standalone vCenter, or, in Enhanced Linked Mode, a cold (powered off) snapshot of every VCSA and PSC, all taken at the same point so they can be restored together. In Enhanced Linked Mode, Broadcom also asks you to check for stale registrations with `lsdoctor` before running it.

**Firefox only.** [KB 313406](https://knowledge.broadcom.com/external/article/313406) (7.0 U3i and later, 8.0 and later): smart card login works in Edge and Chrome but fails in Firefox, because Firefox does not send client certificates in the CORS preflight. In `about:config` set `network.cors_preflight.allow_client_cert` to `true`, then add certificate exceptions for the vCenter on both 443 and 3128.

## Cause 3: STIG Hardening Changed the SSO Authentication Policy

[KB 377069](https://knowledge.broadcom.com/external/article/377069/when-attempting-to-log-into-vcenter-usin.html) (vCenter 7.0): after STIG rules were applied, SSO users get "User name and password are required" and LDAP users get "Unable to login because you do not have permission on any vCenter Server systems connected to this client". Certificates and services are healthy. The cause is STIG rule SV-256363r885700_rule applied where it does not belong. Broadcom says the rule is designed for environments where smart card authentication is **not** enabled and password and Windows session authentication are not disabled. Applied to a vCenter that already uses smart card or ADFS login, it conflicts with the existing authentication methods. The rule also does not apply when a federated identity provider such as ADFS is configured for identity sources, so do not apply it to a vCenter federated with ADFS. Check the policy:

```bash
/opt/vmware/bin/sso-config.sh -get_authn_policy -t vsphere.local
```

For password logins, password and Windows authentication should be enabled and certificate and SecurID authentication disabled. Set it back and restart:

```bash
/opt/vmware/bin/sso-config.sh -set_authn_policy -pwdAuthn true -winAuthn true -certAuthn false -securIDAuthn false -t vsphere.local
service-control --stop --all && service-control --start --all
```

If the environment really does require smart card only login, leave the policy as it is and fix the smart card path (Cause 2) instead.

## Cause 4: Stale Browser State

If `curl` and PowerCLI log in but the browser does not, the server is fine. A common trigger is reverting vCenter to a snapshot or replacing its certificate while a browser session is open. One field report ([Derek Seaman](https://www.derekseaman.com/2021/03/problem-solved-cant-login-to-the-vcenter-appliance.html)) also noticed the **Use Windows session authentication** checkbox appearing enabled when it should have been greyed out. To fix it:

1. Clear cookies and site data for the vCenter FQDN, or try a private window.
2. Reload the login page with a hard refresh.
3. If you pinned or imported the old vCenter certificate locally, remove it and accept the current one.

## Checks That Rule Out Other Causes

- **Time.** `InvalidTimeRange` in the logs can also come from clock drift between vCenter, the ESXi hosts and domain controllers. Compare `date -u` on the appliance with a known good source, and check NTP in the VAMI under **Time**.
- **Locked or expired accounts.** A locked account or an expired password produces its own lockout or password change message rather than this one. For password resets and the SSO and root password policies, see the [VMware default passwords and credentials reference](/vmware-default-passwords-security-guide/). For ESXi lockouts, see [unlocking the root account on ESXi](/post/unlock-root-account-on-esxi/).
- **Identity source down.** If only Active Directory or LDAP users fail and `administrator@vsphere.local` works, the problem is the identity source (a dead domain controller, an expired LDAPS certificate, a broken domain join), not STS. [Removing vCenter from a dead Active Directory domain](/post/vcenter-failing-to-leave-domain/) covers one version of that.

## Prevent It From Happening Again

- Track the STS signing certificate expiry yourself rather than relying on vCenter to warn you. vCert menu 9 generates a certificate report; run it on a regular cadence and record the STS expiry date.
- After any in-place upgrade, check the STS certificate dates rather than assuming the upgrade renewed it.
- Snapshot every vCenter in the SSO domain before certificate work, and restore them together if you have to.
- Keep a second break-glass path to the appliance (console access and the root password) that does not depend on SSO, so you can still run vCert when every SSO login fails.

## References

- Broadcom KB 316619: ["Signing certificate is not valid" or "No healthy upstream" error in vCenter Server Appliance](https://knowledge.broadcom.com/external/article?legacyId=76719)
- Broadcom KB 377558: [Logging in to vCenter VAMI or SSH with the SSO admin fails](https://knowledge.broadcom.com/external/article/377558/error-unable-to-authenticate-user.html)
- Broadcom KB 385107: [vCert, scripted vCenter expired certificate replacement](https://knowledge.broadcom.com/external/article/385107)
- Broadcom KB 405165: [Smart card authentication fails with "user name and password are required"](https://knowledge.broadcom.com/external/article/405165/unable-to-authenticate-with-smart-card-a.html)
- Broadcom KB 373735: [Smart card authentication fails because port 3128 does not use MACHINE_SSL_CERT](https://knowledge.broadcom.com/external/article/373735/smartcard-authentication-in-vcenter-fail.html)
- Broadcom KB 313406: [Smart card authentication does not work in Firefox](https://knowledge.broadcom.com/external/article/313406)
- Broadcom KB 377069: [Smart card or SSO login fails after STIG hardening](https://knowledge.broadcom.com/external/article/377069/when-attempting-to-log-into-vcenter-usin.html)
